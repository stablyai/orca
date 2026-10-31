import type { RpcContext } from '../core'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type {
  SwitchStoppedCliTurn,
  SwitchTranscriptSource
} from '../../../native-chat/agent-session-wire/structured-agent-session-switch-import'
import { armSwitchTurnBoundaryWait } from '../../../native-chat/agent-session-wire/structured-agent-session-switch-turn-boundary'
import type { AgentSessionSwitchDeadline } from '../../../../shared/agent-session-switch-execution'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import { worktreeIdsEqual } from '../../../../shared/worktree/id'
import { interruptWorkingAgent } from '../../terminal-agent-interrupt'
import { mainAgentState } from '../../../../shared/main-agent-status'
import type { AiVaultAgent } from '../../../../shared/ai-vault-types'
import type { captureStructuredSwitchTerminalSource } from './structured-agent-session-switch-source'

/** False consent: the client left it to this host, so a replying terminal agent is refused. */
export function requireTerminalSwitchConsent(
  row: ReturnType<RpcContext['runtime']['agentTransitions']['latestRow']>,
  consented: boolean | undefined
): void {
  if (consented === false && row && mainAgentState(row) === 'working') {
    throw agentSessionRefusalError('agent_session_operation_invalid', { reason: 'turnActive' })
  }
}

/**
 * A terminal source's stop: Escape a replying agent, let it record its own end of that turn
 * (bounded), then stop the exact process with exit proof. Nothing here waits on the transcript to
 * decide whether the stop happens; a turn still open after the stop settles at the resting import.
 */
export async function stopStructuredSwitchTerminalSource(input: {
  ctx: RpcContext
  host: StructuredAgentSessionHost
  sessionId: string
  close: NonNullable<ReturnType<typeof captureStructuredSwitchTerminalSource>>
  paneKey: string
  deadline: AgentSessionSwitchDeadline
  destination: string | undefined
  boundary?: { source: SwitchTranscriptSource; stopped: SwitchStoppedCliTurn }
  keepSource: (settle: (replacedBy: string | undefined) => void) => void
  /** False: the client left consent to this host, so a replying agent is refused, not stopped. */
  consented?: boolean
  /** The stopped agent, named by the pane the window keeps on screen. */
  agent?: AiVaultAgent
}): Promise<void> {
  const { ctx, host, sessionId, close, deadline } = input
  // Checked where the stop is admitted (before the Escape, at its write, and before the exit), so
  // a turn the user started while the switch prepared is never stopped without their yes.
  const requireConsent = (): void =>
    requireTerminalSwitchConsent(
      input.consented === false ? ctx.runtime.agentTransitions.latestRow(input.paneKey) : null,
      input.consented
    )
  requireConsent()
  const awaitBoundary = input.boundary
    ? await armSwitchTurnBoundaryWait(
        input.boundary.source,
        input.boundary.stopped,
        deadline.signal,
        deadline.remaining
      )
    : undefined
  const interrupted = await interruptWorkingAgent(
    ctx.runtime,
    (key) => ctx.runtime.agentTransitions.latestRow(key),
    input.paneKey,
    {
      signal: deadline.signal,
      beforeWrite: async () => {
        deadline.check()
        requireConsent()
      }
    }
  )
  if (interrupted.outcome === 'accepted') {
    await awaitBoundary?.()
  }
  // Only a tab the chat will replace keeps its exited pane shown for that write; a source in
  // another workspace, or a pane in a split, exits as any pane does.
  const replacing =
    input.destination !== undefined &&
    worktreeIdsEqual(close.source.worktreeId, input.destination) &&
    close.wholeTab()
  requireConsent()
  // Shutdown already accepted must finish even when the observing request expires.
  try {
    await host.trackSwitchPhysical(sessionId, close.stop(replacing))
    // The window decides whether the stopped pane is still there; a chat that replaced it is
    // named so the window waits for that replace's own pass.
    input.keepSource((replacedBy) => close.settleStoppedSource(replacedBy, input.agent))
  } catch {
    host.deps.logger.warn('switch source exit was not confirmed', {
      scope: 'session-switch',
      sessionId,
      direction: 'chat',
      source: 'terminal',
      exactIncarnation: true
    })
    throw agentSessionRefusalError('agent_session_ownership_unknown', { reason: 'ownerUnproven' })
  }
}
