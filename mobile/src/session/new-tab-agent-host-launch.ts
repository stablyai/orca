import type { MobileQuickCommandLaunch } from '../terminal/quick-commands'
import type { MobileSessionTab } from './mobile-session-route-types'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import { AGENT_LAUNCH_PLACEMENT_RUNTIME_CAPABILITY } from '../../../src/shared/agent-launch-runtime-capability'
import type { RpcClient } from '../transport/rpc-client'
import { triggerError, triggerSuccess } from '../platform/haptics'
import {
  launchAgentInExistingWorkspace,
  reserveMobileAgentLaunch
} from './mobile-existing-agent-launch'
import { AGENT_PROMPT_NOT_SENT_MESSAGE } from './pr-ai-triage-launch'
import {
  isLaunchedSurfaceListed,
  launchedSelection,
  withLaunchReply,
  withoutUnansweredLaunch,
  type PendingSessionSelection
} from './pending-session-selection'

const NOTES_NOT_SENT_MESSAGE = "The agent started, but the notes weren't sent."
export const PROMPT_UNCONFIRMED_MESSAGE =
  "The agent started, but couldn't confirm the prompt was sent."
export const NOTES_UNCONFIRMED_MESSAGE =
  "The agent started, but couldn't confirm the notes were sent."

export type NewTabAgentLaunchOptions = MobileQuickCommandLaunch['options'] & {
  onPromptSent?: () => void
}

/** Agent launches that `agent.launch` can carry: bare, or with a prompt to submit. A shell command
 *  or an unsent draft stays a plain terminal. */
export function launchesThroughHost(options: NewTabAgentLaunchOptions | undefined): boolean {
  return options?.startupCommand === undefined && options?.enter !== false
}

/** The host's id for a session tab: a terminal pane is listed under its parent tab. */
function hostTabIdOf(
  tabs: readonly MobileSessionTab[],
  sessionTabId: string | null | undefined
): string | undefined {
  const tab = sessionTabId ? tabs.find((candidate) => candidate.id === sessionTabId) : undefined
  if (!tab) {
    return undefined
  }
  return tab.type === 'terminal' ? tab.parentTabId : tab.id
}

/**
 * The "+" menu's agent start through `agent.launch`. The phone lands on the tab when it is listed,
 * which for a paste-after-start agent is long before the reply; the reply only reports delivery.
 * `false` means this host can't take the launch and nothing was started.
 */
export async function launchNewTabAgentThroughHost(args: {
  client: RpcClient
  hostCapabilities: readonly string[] | null | undefined
  worktreeId: string
  agent: TuiAgent
  options: NewTabAgentLaunchOptions | undefined
  /** Names this launch's pending selection, as it names the "+" lock. */
  lock: string
  /** The session tab the user is on; the new tab follows it, as the plain "+" terminal does. */
  activeSessionTabId?: string | null
  pendingSelectionRef: { current: PendingSessionSelection | null }
  fetchSessionTabs: () => Promise<void>
  getSessionTabs: () => readonly MobileSessionTab[]
  showToast: (message: string, durationMs?: number) => void
  reportCreateFailure: (hostReason: string) => void
  setCreateError: (message: string) => void
}): Promise<boolean> {
  const { options, pendingSelectionRef, showToast } = args
  const prompt = options?.agentPrompt ?? options?.initialPrompt
  const reservation = reserveMobileAgentLaunch(args.agent)
  // An older host would drop it anyway; asking only a host that reads it keeps the request as before.
  const afterTabId = args.hostCapabilities?.includes(AGENT_LAUNCH_PLACEMENT_RUNTIME_CAPABILITY)
    ? hostTabIdOf(args.getSessionTabs(), args.activeSessionTabId)
    : undefined
  // Why: armed before asking, because the reply waits for prompt delivery while the tab is listed
  // as soon as it exists. A tab the user picks meanwhile replaces this.
  pendingSelectionRef.current = launchedSelection(args.lock, reservation, null)
  const launched = await launchAgentInExistingWorkspace({
    client: args.client,
    hostCapabilities: args.hostCapabilities,
    worktreeId: args.worktreeId,
    agent: args.agent,
    reservation,
    ...(afterTabId ? { placement: { afterTabId } } : {}),
    ...(prompt?.trim() ? { prompt: { text: prompt, delivery: 'submit' as const } } : {}),
    ...(options?.agentPrompt
      ? { launchSource: 'quick_command' }
      : options?.initialPrompt
        ? { launchSource: 'diff_notes_send' }
        : {})
  })
  if (launched.kind === 'unsupported') {
    pendingSelectionRef.current = withoutUnansweredLaunch(pendingSelectionRef.current, args.lock)
    return false
  }
  if (launched.kind === 'failed') {
    args.reportCreateFailure(launched.message)
    return true
  }
  if (launched.kind === 'tab-closed') {
    // Why silent: the tab this "+" opened is gone, which is the answer; the close was a user's own.
    pendingSelectionRef.current = withoutUnansweredLaunch(pendingSelectionRef.current, args.lock)
    return true
  }
  if (launched.kind === 'unknown') {
    // Why: a listed tab proves the agent started, so only the prompt is in doubt; notes stay unsent.
    if (isLaunchedSurfaceListed(args.getSessionTabs(), reservation)) {
      if (prompt?.trim()) {
        triggerError()
        showToast(
          options?.initialPrompt ? NOTES_UNCONFIRMED_MESSAGE : PROMPT_UNCONFIRMED_MESSAGE,
          2400
        )
      }
      return true
    }
    // Never start a second agent when the first may already be running.
    args.setCreateError(launched.message)
    triggerError()
    showToast(launched.message, 1800)
    return true
  }
  const { outcome, warning } = launched.result
  // An older host ignores the reservation, so the reply's own ids are the fallback.
  pendingSelectionRef.current = withLaunchReply(
    pendingSelectionRef.current,
    args.lock,
    outcome.kind === 'structured' ? { sessionId: outcome.sessionId } : { handle: outcome.handle }
  )
  // Why: the host publishes the tab before it replies, so read it now rather than after a delay.
  void args.fetchSessionTabs()
  if (launched.promptDelivered === false) {
    triggerError()
    showToast(options?.initialPrompt ? NOTES_NOT_SENT_MESSAGE : AGENT_PROMPT_NOT_SENT_MESSAGE, 2400)
  } else if (launched.promptDelivered && options?.initialPrompt) {
    triggerSuccess()
    showToast(options.successToast ?? 'Notes sent')
    options.onPromptSent?.()
  } else if (warning?.trim()) {
    showToast(warning.trim(), 2400)
  }
  return true
}
