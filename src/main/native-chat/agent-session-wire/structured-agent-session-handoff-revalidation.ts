import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionHandoffRequest } from '../../../shared/agent-session-wire'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-projection'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { structuredHandoffRetryResumesStoppedOwner } from './structured-agent-session-handoff-admission'
import { structuredSessionHasPendingPrompt } from './structured-agent-session-handoff-status'

export function assertScheduledStructuredHandoffIsAdmissible(input: {
  record: AgentSessionRecord
  journal: AgentSessionJournal
  params: AgentSessionHandoffRequest
  turnId: string | null
  journalSequence: number
  tuiAlreadyExited: boolean
  tuiStatus: 'idle' | 'busy'
}): void {
  const { params, record } = input
  if (params.action === 'retry' && structuredHandoffRetryResumesStoppedOwner(record, params)) {
    return
  }
  const expectedOwner = params.direction === 'to-tui' ? 'native' : 'tui'
  if (
    record.lease.runtimeFence !== params.envelope.expectedRuntimeFence ||
    record.lease.runtimeKind !== expectedOwner ||
    record.lease.claimStatus !== 'live' ||
    record.lease.handoffStage !== null ||
    record.lease.unreconciled
  ) {
    throw new Error('agent_session_checkpoint_stale')
  }
  if (structuredSessionHasPendingPrompt(input.journal)) {
    throw new Error('Resolve the pending question or approval before switching.')
  }
  if (params.mode !== 'stop-turn' && input.journal.cursor().sequence !== input.journalSequence) {
    throw new Error('The session changed before the handoff started.')
  }
  const activeTurn = activeStructuredAgentSessionTurnId(input.journal.snapshot().items)
  if (params.direction === 'to-tui') {
    const expectedTurn = params.mode === 'stop-turn' ? input.turnId : null
    if (activeTurn !== expectedTurn) {
      throw new Error('The native turn changed before the handoff started.')
    }
    return
  }
  if (
    !input.tuiAlreadyExited &&
    input.tuiStatus !== 'idle' &&
    (params.mode !== 'after-turn' || activeTurn !== null)
  ) {
    throw new Error('The agent terminal became busy before the handoff started.')
  }
}
