import {
  AGENT_SESSION_REWIND_REASONS,
  type AgentSessionRewindParams,
  type AgentSessionRewindReason
} from '../../../shared/agent-session-rewind'
import { refuse, type AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export function rewindRefusal(reason: AgentSessionRewindReason): {
  ok: false
  refusal: AgentSessionWireRefusal
} {
  const rewindReason =
    AGENT_SESSION_REWIND_REASONS.find((value) => value === reason) ?? 'outcome-unknown'
  const message = `agent_session_rewind:${rewindReason}`
  return {
    ok: false,
    refusal:
      rewindReason === 'outcome-unknown'
        ? refuse(
            'agent_session_operation_unknown',
            { reason: 'rewindUnconfirmed', rewindReason },
            message
          )
        : refuse(
            'agent_session_operation_invalid',
            { reason: 'rewindRefused', rewindReason },
            message
          )
  }
}

/** A rewind to a row a /clear left behind, or against an epoch since moved, is refused before any
 *  agent starts for it; null when the journal has no clear to check against. */
export function rewindRefusalBehindClear(
  journal: Pick<AgentSessionJournal, 'context' | 'cursor' | 'snapshot'> | undefined,
  target: Pick<AgentSessionRewindParams, 'itemId' | 'expectedEpoch'>
): ReturnType<typeof rewindRefusal> | null {
  const floor = journal?.context.floor()
  if (!journal || !floor) {
    return null
  }
  if (journal.cursor().epoch !== target.expectedEpoch) {
    return rewindRefusal('stale-epoch')
  }
  const item = journal.snapshot().items.find((entry) => entry.itemId === target.itemId)
  return !item || item.sequence <= floor.sequence ? rewindRefusal('invalid-target') : null
}
