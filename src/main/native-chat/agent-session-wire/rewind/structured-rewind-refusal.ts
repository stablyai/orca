import type { AgentSessionRewindParams } from '../../../../shared/agent-session/lifecycle/rewind/agent-session-rewind'
import { AGENT_SESSION_REWIND_REASONS } from '../../../../shared/agent-session/lifecycle/rewind/agent-session-rewind-reasons'
import type { AgentSessionRewindReason } from '../../../../shared/agent-session/lifecycle/rewind/agent-session-rewind-reasons'
import {
  refuse,
  type AgentSessionWireRefusal
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'

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

/** Refuse pre-/clear targets or moved epochs before starting an agent. */
export async function rewindRefusalBehindClear(
  journal: Pick<AgentSessionJournal, 'reads'> | undefined,
  target: Pick<AgentSessionRewindParams, 'itemId' | 'expectedEpoch'>
): Promise<ReturnType<typeof rewindRefusal> | null> {
  if (!journal) {
    return null
  }
  const selected = await journal.reads.rewindTarget(target.itemId)
  if (!selected.floor) {
    return null
  }
  if (selected.cursor.epoch !== target.expectedEpoch) {
    return rewindRefusal('stale-epoch')
  }
  return selected.sequence !== null && selected.sequence > selected.floor.sequence
    ? null
    : rewindRefusal('invalid-target')
}
