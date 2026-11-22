import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

export type JournalStatusPosition = { sequence: number; sequenceIndex: number; ordinal: number }
export type JournalStatusItem = { item: AgentJournalRenderItem; position: JournalStatusPosition }
export type JournalStatusItemSelection =
  | { kind: 'boundary'; raw?: true }
  | { kind: 'clear' }
  | {
      kind: 'turns'
      root?: true
      floor?: number
      before?: number
      first?: true
      direction?: 'asc' | 'desc'
    }
  /** Newest first, or oldest first from `after`; fromPerson leaves out another agent's messages. */
  | {
      kind: 'users'
      floor?: number
      unknown?: true
      fromPerson?: true
      after?: JournalStatusPosition
      before?: JournalStatusPosition
    }
  | { kind: 'assistant-prose'; floor?: number; turnItemId?: string }
  | { kind: 'async-question-candidates'; floor?: number }
  | { kind: 'assistant-exists' }
  | { kind: 'prompt' }
  | { kind: 'pending-prompts'; floor?: number }
  | { kind: 'scoped-statuses'; turnItemId: string; floor?: number }
  | { kind: 'tools'; after: JournalStatusPosition; running?: true }

export function compareJournalStatusPositions(a: JournalStatusPosition, b: JournalStatusPosition) {
  return a.sequence - b.sequence || a.sequenceIndex - b.sequenceIndex || a.ordinal - b.ordinal
}
