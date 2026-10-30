import type { ExternalConversationLink } from '../../shared/external-conversation-link'
import type { LaunchedAgentReadinessRuntime } from '../runtime/launched-agent-composer-readiness'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { waitForStartedAgentReady } from '../runtime/rpc/methods/agent-launch-terminal-prompt'
import type { AgentSessionResumeRefusal } from '../runtime/session-lifecycle/projection/resume-agent-session-in-workspace'
import { refusalOf } from './external-conversation-chain'
import { bindPane, type FollowUpTerminal } from './external-conversation-send'
import type { ConnectorRefusal } from './external-conversation-types'

export type ReopenTerminal = Pick<
  OrcaRuntimeService,
  'resumeAgentSessionInWorkspace' | 'getAgentStatusRowsForPane'
> &
  LaunchedAgentReadinessRuntime &
  Pick<FollowUpTerminal, 'getTerminalHandleForPaneKey' | 'getTerminalPromptRequestBinding'>

const REOPEN_REFUSALS: Record<Exclude<AgentSessionResumeRefusal, 'aborted'>, ConnectorRefusal> = {
  window_owns_wake: 'agent_asleep_in_window',
  // An unreachable SSH host may still run the old pane, so reopening would risk duplicates.
  held_elsewhere: 'agent_not_reachable',
  no_resume_command: 'reopen_refused',
  create_failed: 'reopen_refused',
  // Connector refusal codes are a published set; the host-side result keeps the fix-it message.
  windows_only_cli: 'reopen_refused'
}

/** Resume only the linked session after proving it is unheld; never substitute a shell or fresh agent. */
export async function reopenLinkedAgent(
  terminal: ReopenTerminal,
  worktreeId: string,
  link: ExternalConversationLink,
  mutationId: string,
  signal: AbortSignal,
  /** Called as soon as the resumed pane exists, before the readiness wait. */
  onReopened: (paneKey: string) => void
): Promise<
  | { ok: true; pane: NonNullable<ReturnType<typeof bindPane>> }
  | { ok: false; refusal: ConnectorRefusal }
> {
  const { providerSession, captureHostId } = link
  if (!providerSession || !captureHostId) {
    return { ok: false, refusal: 'no_session_to_reopen' }
  }
  const resumed = await terminal.resumeAgentSessionInWorkspace(worktreeId, {
    agent: link.agent,
    providerSession,
    captureHostId,
    mutationId,
    signal
  })
  if (!resumed.ok) {
    return {
      ok: false,
      refusal: resumed.reason === 'aborted' ? refusalOf(signal) : REOPEN_REFUSALS[resumed.reason]
    }
  }
  onReopened(resumed.paneKey)
  const pane = bindPane(terminal, resumed.paneKey)
  if (!pane || pane.handle !== resumed.handle || pane.binding.ptyId !== resumed.ptyId) {
    return { ok: false, refusal: 'agent_not_reachable' }
  }
  const ready = await waitForStartedAgentReady(terminal, resumed.handle, link.agent, signal).catch(
    () => null
  )
  if (signal.aborted) {
    return { ok: false, refusal: refusalOf(signal) }
  }
  // A missing or unsatisfied composer must not accept the message.
  return ready === null || (ready && !ready.satisfied)
    ? { ok: false, refusal: 'agent_not_reachable' }
    : { ok: true, pane }
}
