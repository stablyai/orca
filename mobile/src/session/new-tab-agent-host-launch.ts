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
import { agentPromptNotSentMessage } from './pr-ai-triage-launch'
import { translate } from '../i18n/mobile-i18n'
import {
  isLaunchedSurfaceListed,
  launchedSelection,
  withLaunchReply,
  withoutUnansweredLaunch,
  type PendingSessionSelection
} from './pending-session-selection'

export const PROMPT_UNCONFIRMED_MESSAGE =
  "The agent started, but couldn't confirm the prompt was sent."
export const NOTES_UNCONFIRMED_MESSAGE =
  "The agent started, but couldn't confirm the notes were sent."

export type NewTabAgentLaunchOptions = MobileQuickCommandLaunch['options'] & {
  onPromptSent?: () => void
}

// Shell commands and unsent drafts require plain terminals rather than agent.launch.
export function launchesThroughHost(options: NewTabAgentLaunchOptions | undefined): boolean {
  return options?.startupCommand === undefined && options?.enter !== false
}

// Host placement uses the parent tab id for terminal panes.
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

// Listed tabs may precede prompt-delivery replies; false permits fallback only when this host started nothing.
export async function launchNewTabAgentThroughHost(args: {
  client: RpcClient
  hostCapabilities: readonly string[] | null | undefined
  worktreeId: string
  agent: TuiAgent
  options: NewTabAgentLaunchOptions | undefined
  lock: string
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
  const afterTabId = args.hostCapabilities?.includes(AGENT_LAUNCH_PLACEMENT_RUNTIME_CAPABILITY)
    ? hostTabIdOf(args.getSessionTabs(), args.activeSessionTabId)
    : undefined
  // Arm selection before requesting: tabs publish before prompt delivery settles, and later user picks must win.
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
    // Closing the newly opened tab is a user action, so settle silently.
    pendingSelectionRef.current = withoutUnansweredLaunch(pendingSelectionRef.current, args.lock)
    return true
  }
  if (launched.kind === 'unknown') {
    // A listed tab proves startup, leaving only prompt delivery uncertain; keep notes unsent.
    if (isLaunchedSurfaceListed(args.getSessionTabs(), reservation)) {
      if (prompt?.trim()) {
        triggerError()
        showToast(
          options?.initialPrompt
            ? translate(
                'session.newTabAgentHostLaunch.notesUnconfirmed',
                "The agent started, but couldn't confirm the notes were sent."
              )
            : translate(
                'session.newTabAgentHostLaunch.promptUnconfirmed',
                "The agent started, but couldn't confirm the prompt was sent."
              ),
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
  // Refresh immediately because the host publishes the tab before replying.
  void args.fetchSessionTabs()
  if (launched.promptDelivered === false) {
    triggerError()
    showToast(
      options?.initialPrompt
        ? translate(
            'session.newTabAgentHostLaunch.notesNotSent',
            "The agent started, but the notes weren't sent."
          )
        : agentPromptNotSentMessage(),
      2400
    )
  } else if (launched.promptDelivered && options?.initialPrompt) {
    triggerSuccess()
    showToast(
      options.successToast ?? translate('session.newTabAgentHostLaunch.notesSent', 'Notes sent')
    )
    options.onPromptSent?.()
  } else if (warning?.trim()) {
    showToast(warning.trim(), 2400)
  }
  return true
}
