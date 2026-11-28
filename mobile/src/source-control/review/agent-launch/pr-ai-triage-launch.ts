import type { SourceControlLaunchActionId } from '../../../../../src/shared/source-control/ai/recipes/source-control-ai-actions'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import {
  launchAgentInExistingWorkspace,
  supportsMobileExistingAgentLaunch
} from '../../../session/agent-launch/mobile-existing-agent-launch'
import {
  agentPromptNotSentMessage,
  agentStartedMessage,
  promptedAgentLaunchResult,
  type MobilePromptedAgentLaunch
} from '../../../session/agent-launch/mobile-prompted-agent-launch'
import {
  hostRefusesOtherRuntimeWorkspace,
  loadMobileAgentLaunchContext
} from '../../../session/agent-launch/mobile-new-tab-agent-loader'
import {
  hostOpensChatsWithoutCli,
  resolveMobileSourceControlLaunchAgent
} from './mobile-source-control-launch-agent'
import { readMobileRegisteredAgents } from '../../../session/native-chat/agent-session/use-mobile-registered-agent'
import { projectSourceControlActionLaunch } from '../../../../../src/shared/source-control/ai/recipes/source-control-action-launch-preferences'
import { translate } from '../../../i18n/mobile-i18n'
import type { LaunchedAgentOpens } from '../../../session/agent-launch/launched-agent-opener'

// Have the host launch and deliver AI prompts; mobile must never type them into a shell.

export async function launchAgentWithPrompt(args: {
  client: RpcClient
  hostCapabilities: readonly string[] | null | undefined
  worktreeId: string
  actionId: SourceControlLaunchActionId | null
  prompt: string
  launchSource: string
}): Promise<MobilePromptedAgentLaunch> {
  if (!supportsMobileExistingAgentLaunch(args.hostCapabilities)) {
    return {
      kind: 'not-started',
      message: translate(
        'session.prAiTriageLaunch.updateRequired',
        'Update Orca on this host to start an agent from your phone.'
      )
    }
  }
  let resolved
  try {
    const hostCapabilities = args.hostCapabilities ?? []
    const contextRequest = loadMobileAgentLaunchContext({
      client: args.client,
      worktreeId: args.worktreeId,
      hostRefusesOtherRuntime: hostRefusesOtherRuntimeWorkspace(args.hostCapabilities)
    })
    // Only a chat host can open an agent without a CLI; read alongside detection.
    const registeredAgents = hostOpensChatsWithoutCli(hostCapabilities)
      ? readMobileRegisteredAgents(args.client)
      : null
    const context = await contextRequest
    resolved = resolveMobileSourceControlLaunchAgent(context, args.actionId, translate, {
      hostCapabilities,
      registeredAgents: await registeredAgents
    })
  } catch (error) {
    const message = error instanceof Error ? error.message.trim() : ''
    return {
      kind: 'not-started',
      message:
        message ||
        translate('session.prAiTriageLaunch.loadFailed', 'Could not load the available agents.')
    }
  }
  if (resolved.kind === 'unavailable') {
    return { kind: 'not-started', message: resolved.message }
  }
  const { recipe } = resolved
  const projection = projectSourceControlActionLaunch(recipe ?? {}, resolved.agent, {
    basePrompt: args.prompt
  })
  const text = projection.commandInput
  if (!text) {
    return {
      kind: 'not-started',
      message: translate(
        'session.prAiTriageLaunch.emptyPrompt',
        "This action's saved prompt is empty. Update Source Control AI settings on your computer."
      )
    }
  }
  const launched = await launchAgentInExistingWorkspace({
    client: args.client,
    hostCapabilities: args.hostCapabilities,
    worktreeId: args.worktreeId,
    agent: resolved.agent,
    ...(projection.sessionOptions ? { chatOptions: projection.sessionOptions } : {}),
    agentArgs: projection.agentArgs,
    // Without a CLI only a chat can run, so ask for one: the host refuses it rather than start a terminal.
    surface: resolved.chatOnly ? 'chat' : projection.requestedSurface,
    // A saved Chat is a preference: the host opens a chat where one can run, as desktop does.
    ...(!resolved.chatOnly && projection.preferredSurface === 'chat'
      ? { nativeChatDefault: true }
      : {}),
    prompt: { text, delivery: 'submit' },
    launchSource: args.launchSource
  })
  return promptedAgentLaunchResult(launched, text)
}

// Host warnings describe completed launches and must not become failure notices.
export function promptedLaunchNotice(
  result: MobilePromptedAgentLaunch,
  workspaceLabel?: string | null
): {
  succeeded: boolean
  success: string | null
  error: string | null
  warning: string | null
  undeliveredPrompt: string | null
  opens: LaunchedAgentOpens | null
} {
  switch (result.kind) {
    case 'sent':
      return {
        succeeded: true,
        success: agentStartedMessage(workspaceLabel),
        error: null,
        warning: result.warning ?? null,
        undeliveredPrompt: null,
        opens: result.opens
      }
    case 'prompt-not-sent':
      return {
        succeeded: false,
        success: null,
        error: agentPromptNotSentMessage(),
        warning: result.warning ?? null,
        undeliveredPrompt: result.prompt,
        opens: result.opens
      }
    case 'not-started':
    case 'unconfirmed':
      return {
        succeeded: false,
        success: null,
        error: result.message,
        warning: null,
        undeliveredPrompt: null,
        opens: null
      }
  }
}
