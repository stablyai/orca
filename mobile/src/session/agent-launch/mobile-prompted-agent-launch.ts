import { translate } from '../../i18n/mobile-i18n'
import { readAgentLaunchNotice } from './agent-launch-request'
import type { AgentLaunchResult } from '../../../../src/shared/agent-launch/contracts/agent-launch-intent'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../src/shared/agent-session/view/structured-agent-session-projection'
import type { LaunchedAgentOpens } from './launched-agent-opener'
import type { MobileExistingAgentLaunch } from './mobile-existing-agent-launch'

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

/** What a launch that carried `text` as its prompt means for the screen that started it. */
export function promptedAgentLaunchResult(
  launched: MobileExistingAgentLaunch,
  text: string
): MobilePromptedAgentLaunch {
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
          'Update Orca on this host to start an agent from your phone.'
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
