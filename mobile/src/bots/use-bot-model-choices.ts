// The bot's model and effort choices: its computer's model lists for its agent in its folder, the read the
// desktop's Agent and model page makes, through the same shared picker rules.
import { useEffect, useState } from 'react'
import type { AgentSessionModelCatalogResult } from '../../../src/shared/agent-session/agent-session-wire'
import type { CatalogOption } from '../../../src/shared/agent-session/options/catalog-providers/agent-session-option-catalog-types'
import type { AgentPickerModel } from '../../../src/shared/agent-launch/picker/agent-launch-picker'
import {
  agentPickerEntryOptions,
  agentPickerModels
} from '../../../src/shared/agent-launch/picker/agent-launch-picker-catalog'
import { isTuiAgent } from '../../../src/shared/agent-launch/catalog/tui-agent-config'
import { keptSetupCatalog } from '../../../src/shared/agent-launch/picker/agent-launch-kept-setup-catalog'
import type { BotLaunch } from '../../../src/shared/bots/bot-launch'
import { folderWorkspaceKey } from '../../../src/shared/workspace/identity/workspace-scope'
import { listedModelDescribing } from '../../../src/shared/agent-session/options/model-catalog/structured-agent-session-listed-model'
import { parseStructuredLaunchSeedOptions } from '../../../src/shared/native-chat/input/session-options/native-chat-session-option-defaults'
import { callAgentSession } from '../session/native-chat/agent-session/mobile-structured-agent-session-rpc'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'

type EffortOption = CatalogOption & { kind: { type: 'select' } }

export type BotModelChoices = {
  models: AgentPickerModel[]
  /** The model a new chat starts on: the bot's, else the computer's chat default. Undefined when the
   *  listing names no default and nothing was picked. */
  modelId: string | undefined
  model: AgentPickerModel | undefined
  effort: { option: EffortOption; value: string } | undefined
}

// Past the host's own wait for a listing (30 s), so its answer arrives rather than a timeout.
const CATALOG_WAIT_MS = 35_000
const CATALOG_WAITS = 3

type HostChoices = {
  catalog: AgentSessionModelCatalogResult
  /** The computer's chat defaults for this agent in the folder, as a new chat would seed them. */
  seed: Record<string, string> | undefined
}

async function readHostChoices(
  client: RpcClient,
  agent: string,
  worktreeId: string,
  signal: AbortSignal
): Promise<HostChoices> {
  const worktree = `id:${worktreeId}`
  const read = (waitForListing: boolean) =>
    callAgentSession<AgentSessionModelCatalogResult>(
      client,
      'agentSession.modelCatalog',
      { agent, worktree, ...(waitForListing ? { waitForListing } : {}) },
      CATALOG_WAIT_MS
    )
  const [first, support] = await Promise.all([
    read(false),
    callAgentSession<{ seedOptions?: Record<string, string> }>(
      client,
      'agentSession.createSupport',
      { worktree, agent }
    ).catch(() => undefined)
  ])
  // A listing still running answers when it lands, as the desktop's picker waits for it.
  let catalog = first
  for (
    let wait = 0;
    !signal.aborted && catalog.listingInProgress && wait < CATALOG_WAITS;
    wait += 1
  ) {
    catalog = await read(true)
  }
  return { catalog, seed: parseStructuredLaunchSeedOptions(support?.seedOptions) }
}

/** Null until the computer answers, and when it can't; read again when it comes back online. */
export function useBotModelChoices(
  client: RpcClient | null,
  online: boolean,
  bot: { agent: string; folderWorkspaceId: string; launch?: BotLaunch }
): BotModelChoices | null {
  return useMobileChatModelChoices(
    client,
    online,
    bot.agent,
    folderWorkspaceKey(bot.folderWorkspaceId),
    bot.launch
  )
}

export function useMobileChatModelChoices(
  client: RpcClient | null,
  online: boolean,
  agent: string | undefined,
  worktreeId: string,
  launch?: BotLaunch
): BotModelChoices | null {
  const [answer, setAnswer] = useState<{
    client: RpcClient
    key: string
    host: HostChoices | null
  } | null>(null)
  const key = `${agent}\n${worktreeId}`
  useEffect(() => {
    if (!client || !online || !agent) {
      return
    }
    const controller = new AbortController()
    void readHostChoices(client, agent, worktreeId, controller.signal).then(
      (host) => !controller.signal.aborted && setAnswer({ client, key, host }),
      () =>
        !controller.signal.aborted &&
        setAnswer((held) =>
          held?.client === client && held.key === key && held.host
            ? held
            : { client, key, host: null }
        )
    )
    return () => {
      controller.abort()
    }
  }, [client, online, agent, worktreeId, key])
  const host = answer?.client === client && answer.key === key ? answer.host : null
  if (!host || !isTuiAgent(agent)) {
    return null
  }
  const entry = {
    agent,
    catalog: keptSetupCatalog(agent, host.catalog),
    defaultSurface: 'chat' as const,
    coherentCatalog: true,
    terminal: {}
  }
  // The bot's own picks over the chat defaults, as a new chat of the bot seeds them.
  const listed = agentPickerModels(entry, 'chat')
  const modelId = launch?.model ?? host.seed?.model ?? listed.find((model) => model.isDefault)?.id
  const models = listed.filter((model) => !model.hidden || model.id === modelId)
  const model = modelId ? listedModelDescribing(models, undefined, modelId) : undefined
  const option = agentPickerEntryOptions(entry, modelId, 'chat').find(
    (candidate): candidate is EffortOption =>
      candidate.id === 'effort' && candidate.kind.type === 'select'
  )
  const effort = launch?.model
    ? launch.options?.effort
    : (launch?.options?.effort ?? host.seed?.effort)
  return {
    models,
    modelId,
    model,
    effort: option ? { option, value: effort ?? option.kind.defaultValue } : undefined
  }
}
