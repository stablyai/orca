import type { SourceControlLaunchActionId } from '../../../../src/shared/source-control/ai/recipes/source-control-ai-actions'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import {
  launchAgentInExistingWorkspace,
  supportsMobileExistingAgentLaunch
} from '../../session/agent-launch/mobile-existing-agent-launch'
import {
  hostRefusesOtherRuntimeWorkspace,
  loadMobileAgentLaunchContext
} from '../../session/agent-launch/mobile-new-tab-agent-loader'
import { resolveMobileSourceControlLaunchAgent } from './mobile-source-control-launch-agent'
import { projectSourceControlActionLaunch } from '../../../../src/shared/source-control/ai/recipes/source-control-action-launch-preferences'
import { translate } from '../../i18n/mobile-i18n'
import { readAgentLaunchNotice } from '../../session/agent-launch/agent-launch-request'
import type { AgentLaunchResult } from '../../../../src/shared/agent-launch/contracts/agent-launch-intent'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../src/shared/agent-session/view/structured-agent-session-projection'
import type { LaunchedAgentOpens } from '../../session/agent-launch/launched-agent-opener'

// Have the host launch and deliver AI prompts; mobile must never type them into a shell.

export type MobilePromptedAgentLaunch =
  | { kind: 'sent'; opens: LaunchedAgentOpens; warning?: string }
  /** The agent started but `prompt`, the text as sent, did not reach it; the caller offers it. */
  | { kind: 'prompt-not-sent'; prompt: string; opens: LaunchedAgentOpens; warning?: string }
  /** Nothing started; `message` says why. */
  | { kind: 'not-started'; message: string }
  /** The agent may be running; do not launch again until the user has looked. */
  | { kind: 'unconfirmed'; message: string }

export const AGENT_PROMPT_NOT_SENT_MESSAGE = "The agent started, but the prompt wasn't sent."

// A chat's pane key is derived as a notification's is, so the session finds the tab the same way.
export function launchedAgentOpens(result: AgentLaunchResult): LaunchedAgentOpens {
  const { outcome, worktreeId } = result
  return outcome.kind === 'structured'
    ? {
        worktreeId,
        paneKey: structuredAgentSessionPaneKey(
          outcome.tabId ?? structuredAgentSessionTabId(outcome.sessionId),
          outcome.sessionId
        )
      }
    : { worktreeId, paneKey: outcome.paneKey ?? null }
}

export function agentPromptNotSentMessage(): string {
  return translate(
    'session.prAiTriageLaunch.promptNotSent',
    "The agent started, but the prompt wasn't sent."
  )
}

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
        'Update Orca on your computer to start an agent from your phone.'
      )
    }
  }
  let resolved
  try {
    resolved = resolveMobileSourceControlLaunchAgent(
      await loadMobileAgentLaunchContext({
        client: args.client,
        worktreeId: args.worktreeId,
        hostRefusesOtherRuntime: hostRefusesOtherRuntimeWorkspace(args.hostCapabilities)
      }),
      args.actionId
    )
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
    surface: projection.requestedSurface,
    prompt: { text, delivery: 'submit' },
    launchSource: args.launchSource
  })
  switch (launched.kind) {
    case 'launched': {
      const warning = readAgentLaunchNotice(launched.result)
      const extra = { opens: launchedAgentOpens(launched.result), ...(warning ? { warning } : {}) }
      return launched.promptDelivered
        ? { kind: 'sent', ...extra }
        : { kind: 'prompt-not-sent', prompt: text, ...extra }
    }
    case 'unsupported':
      return {
        kind: 'not-started',
        message: translate(
          'session.prAiTriageLaunch.updateRequired',
          'Update Orca on your computer to start an agent from your phone.'
        )
      }
    case 'failed':
    case 'tab-closed':
      return { kind: 'not-started', message: launched.message }
    case 'unknown':
      return { kind: 'unconfirmed', message: launched.message }
  }
}

export function agentStartedMessage(workspaceLabel: string | null | undefined): string {
  const label = workspaceLabel?.trim()
  return label
    ? translate('session.prAiTriageLaunch.agentStartedIn', 'Agent started in {{label}}', { label })
    : translate('session.prAiTriageLaunch.agentStarted', 'Agent started')
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
