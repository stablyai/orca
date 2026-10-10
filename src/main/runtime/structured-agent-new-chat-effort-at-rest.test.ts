// A new chat reads its options at rest before its agent starts. That answer must name the model and
// effort the catalog's first frame showed for its workspace, or the picker changes before any start.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionAccountHome, AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionModelOption } from '../../shared/agent-session-wire'
import { structuredAgentSessionSeedCatalog } from '../../shared/structured-agent-session-seed-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot,
  type StructuredAgentSessionOptionState
} from '../../shared/structured-agent-session-options'
import { grokModelCatalogFromState } from '../acp/acp-dialects/grok-model-catalog'
import { acpLaunchSpecFor } from '../acp/acp-launch-specs'
import { acpStructuredAgentDefinition } from '../acp/acp-structured-agent-definitions'
import { CODEX_STRUCTURED_AGENT } from '../codex/codex-structured-agent-definition'
import { agentModelCatalogFingerprintForRecord } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { createAgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  agentReadsProjectModelConfig,
  workspaceMayOverrideDefaultModel
} from '../native-chat/agent-model-catalog/agent-project-model-override'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionMutationContext } from '../native-chat/agent-session-wire/structured-agent-session-host-mutations'
import { readStructuredAgentSessionOptions } from '../native-chat/agent-session-wire/structured-agent-session-options-read'
import { StructuredAgentRegistry } from '../native-chat/agent-session-wire/structured-agent-registry'
import { PI_RPC_AGENT } from '../pi/rpc-agent-definition'
import { piModelCatalogFromListing } from '../pi/rpc-model-catalog-probe'

const unused = (): never => {
  throw new Error('an at-rest read never calls the adapter')
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the registry only checks that declared capabilities have these methods; the at-rest read calls none.
const ADAPTER = {
  compact: unused,
  changeThreadGoal: unused,
  rewind: unused,
  recoverRewind: unused
} as unknown as StructuredAgentSessionAdapter

const AGENTS = new StructuredAgentRegistry(
  [
    CODEX_STRUCTURED_AGENT,
    PI_RPC_AGENT,
    acpStructuredAgentDefinition(acpLaunchSpecFor('grok')!)
  ].map((definition) => ({ definition, adapter: ADAPTER }))
)

const HOMES: Record<string, AgentSessionAccountHome> = {
  codex: { variable: 'CODEX_HOME', path: '/homes/codex' },
  pi: { variable: 'PI_CODING_AGENT_DIR', path: '/homes/pi' },
  grok: { variable: 'GROK_HOME', path: '/homes/grok' }
}

// `model/list` marks the configured model as its default, at the effort its own row names.
const CODEX_LISTING: AgentSessionModelOption[] = [
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    isDefault: true,
    defaultEffort: 'medium',
    efforts: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' }
    ]
  },
  {
    id: 'gpt-5.5-mini',
    label: 'GPT-5.5 Mini',
    isDefault: false,
    defaultEffort: 'low',
    efforts: [
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' }
    ]
  }
]

const GROK_LISTING = grokModelCatalogFromState({
  currentModelId: 'grok-4',
  availableModels: [
    {
      modelId: 'grok-4',
      name: 'Grok 4',
      _meta: {
        supportsReasoningEffort: true,
        reasoningEfforts: [
          { value: 'low', id: 'low' },
          { value: 'medium', id: 'medium', default: true },
          { value: 'high', id: 'high' },
          { value: 'max', id: 'max' }
        ]
      }
    },
    { modelId: 'grok-3-mini', name: 'Grok 3 Mini' }
  ]
})

const PI_LISTING = piModelCatalogFromListing(
  [
    'provider   model            context  max-out  thinking  images',
    'anthropic  claude-sonnet-4  200K     64K      yes       yes',
    'openai     gpt-6            400K     128K     yes       yes'
  ].join('\n')
)

type Account = {
  models: AgentSessionModelOption[]
  /** What an earlier chat with no pick resolved, for an agent whose listing names no default. */
  configured?: { modelId: string; effort: string }
}

const ACCOUNTS: Record<string, Account> = {
  codex: { models: CODEX_LISTING },
  // The account's config runs Grok 4 at max, not the listing's own default of medium.
  grok: { models: GROK_LISTING, configured: { modelId: 'grok-4', effort: 'max' } },
  pi: { models: PI_LISTING, configured: { modelId: 'openai/gpt-6', effort: 'high' } }
}

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-new-chat-effort-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A repo checkout holding `files`, as the project's own agent config. */
function workspace(files: Record<string, string> = {}): string {
  const dir = join(root, 'repo')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere')
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  return dir
}

function newChatRecord(
  agent: string,
  workspacePath: string,
  options: Record<string, string>
): AgentSessionRecord {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the catalog service and the at-rest read touch only these fields.
  return {
    sessionId: `${agent}-new`,
    provider: agent,
    accountHome: HOMES[agent]!,
    launchDirectory: workspacePath,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'ws-1',
      workspaceKind: 'git-worktree'
    },
    options
  } as AgentSessionRecord
}

/** A host whose catalog for `agent`'s account is warm, holding one new chat that never sent. */
function host(agent: string, record: AgentSessionRecord) {
  const store = new AgentModelCatalogStore()
  const fingerprint = agentModelCatalogFingerprintForRecord(record)
  const account = ACCOUNTS[agent]!
  // Not inline: this base's listing still requires the tier map that main has since dropped.
  const listing = {
    models: account.models,
    fastModeTierByModel: new Map(),
    origin: 'probe' as const
  }
  store.recordSuccess(fingerprint, agent, listing, 'discovery')
  if (account.configured) {
    store.recordConfiguredDefault(fingerprint, account.configured)
  }
  const modelCatalog = createAgentModelCatalogService({
    store,
    getRecord: (sessionId) => (sessionId === record.sessionId ? record : undefined),
    drivesRecord: () => true,
    resolveAccountHome: async (name) => HOMES[name]!,
    listingNamesConfiguredModel: new Set(['codex']),
    recordWorkspacePath: async (row) => row.launchDirectory ?? null,
    agentReadsProjectModelConfig,
    workspaceMayOverrideDefaultModel
  })
  const resting = {
    child: null,
    params: { provider: agent },
    journal: { threadGoal: () => null, contextUsage: () => null, context: { floor: () => null } }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the at-rest read touches only these members.
  const context = {
    deps: { adapter: {}, agents: AGENTS, store: { getRecord: () => record }, modelCatalog },
    serialize: (_sessionId: string, task: () => Promise<unknown>) => task(),
    openConversation: async () => resting,
    conversation: async () => resting
  } as unknown as StructuredAgentSessionMutationContext
  return { modelCatalog, context }
}

function pills(state: StructuredAgentSessionOptionState) {
  const snapshot = structuredAgentSessionOptionSnapshot(state)
  const pill = (id: string) => {
    const kind = snapshot.find((descriptor) => descriptor.id === id)?.kind
    return kind?.type === 'select'
      ? { value: kind.currentValue, choices: kind.choices.map((choice) => choice.value) }
      : null
  }
  return { model: pill('model'), effort: pill('effort') }
}

/** The pane's frames: the host catalog for the chat's workspace first, as the new chat's read
 *  names it, then the chat's own options read at rest. */
async function newChatFrames(
  agent: string,
  chat: {
    saved?: Record<string, string>
    projectFiles?: Record<string, string>
    /** False for a client that refuses an answer naming no model, as mobile does today. */
    readsWithoutModel?: boolean
  } = {}
) {
  const workspacePath = workspace(chat.projectFiles)
  const record = newChatRecord(agent, workspacePath, chat.saved ?? {})
  const { modelCatalog, context } = host(agent, record)
  const seed = structuredAgentSessionSeedCatalog(agent)
  const first = applyStructuredAgentSessionModelCatalog(
    createStructuredAgentSessionOptionState(agent, seed),
    seed,
    await modelCatalog.read({ agent, waitForListing: true, workspacePath }),
    { newLaunch: true }
  )
  // Read before applying the answer: applying updates the state's option record in place.
  const firstPills = pills(first)
  const atRest = await readStructuredAgentSessionOptions(context, record.sessionId, {
    readsWithoutModel: chat.readsWithoutModel ?? true
  })
  const settled = applyStructuredAgentSessionOptions(first, seed, atRest)
  return { atRest, first: firstPills, settled: pills(settled) }
}

describe("a new chat's effort pill before its agent starts", () => {
  it.each([
    ['codex', 'gpt-5.5', 'medium'],
    ['grok', 'grok-4', 'max'],
    ['pi', 'openai/gpt-6', 'high']
  ])(
    '%s keeps the first frame’s model and effort through the at-rest read',
    async (agent, model, effort) => {
      const { atRest, first, settled } = await newChatFrames(agent)

      expect(first.model?.value).toBe(model)
      expect(first.effort?.value).toBe(effort)
      expect(settled).toEqual(first)
      expect(atRest.current).toEqual({ model, effort })
    }
  )

  it.each([
    ['codex', '.codex/config.toml', 'model_reasoning_effort = "high"\n'],
    ['pi', '.pi/settings.json', '{ "defaultThinkingLevel": "low" }']
  ])(
    '%s names no default model or effort at rest where the project’s config may pick one',
    async (agent, file, text) => {
      const { atRest, first, settled } = await newChatFrames(agent, {
        projectFiles: { [file]: text }
      })

      expect(first.model?.value).toBeUndefined()
      expect(first.effort).toBeNull()
      expect(settled).toEqual(first)
      expect(atRest.current).toEqual({})
    }
  )

  it('keeps the account default model, with no effort, for a client that needs a model', async () => {
    const { atRest } = await newChatFrames('codex', {
      projectFiles: { '.codex/config.toml': 'model_reasoning_effort = "high"\n' },
      readsWithoutModel: false
    })

    // The account default is not what this repo runs, so its effort is never claimed.
    expect(atRest.current).toEqual({ model: 'gpt-5.5' })
    expect(atRest.conversationCommands).toEqual(['clear', 'compact'])
  })

  it('names the folder’s default effort for a client that needs a model too', async () => {
    const { atRest } = await newChatFrames('codex', { readsWithoutModel: false })

    expect(atRest.current).toEqual({ model: 'gpt-5.5', effort: 'medium' })
  })

  it('keeps a saved effort over the default model’s', async () => {
    const { atRest, settled } = await newChatFrames('grok', { saved: { effort: 'high' } })

    expect(atRest.current).toEqual({ model: 'grok-4', effort: 'high' })
    expect(settled.effort?.value).toBe('high')
  })

  it('leaves the effort of a saved model to the agent, as its running child reports it', async () => {
    const { atRest } = await newChatFrames('codex', { saved: { model: 'gpt-5.5-mini' } })

    expect(atRest.current).toEqual({ model: 'gpt-5.5-mini' })
  })
})
