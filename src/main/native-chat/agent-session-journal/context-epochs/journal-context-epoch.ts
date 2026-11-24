import { createHash } from 'node:crypto'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalReducerState } from '../projection/journal-reducer'

/** Public context identity changes without changing the physical journal's ownership/order. */
export function journalContextEpoch(epoch: string, boundary: number): string {
  return boundary > 1
    ? `context-v1:${createHash('sha256')
        .update(JSON.stringify([epoch, boundary]))
        .digest('hex')}`
    : epoch
}

export function journalContextCursor(
  state: Pick<JournalReducerState, 'epoch' | 'contextBoundary' | 'lastSequence'>,
  sequence = state.lastSequence
): AgentJournalCursor {
  return { epoch: journalContextEpoch(state.epoch, state.contextBoundary), sequence }
}
