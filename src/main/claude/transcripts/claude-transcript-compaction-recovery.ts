import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'

/**
 * Only automatic boundaries are recovered from a transcript. Orca's own /compact writes its row
 * live, and Claude saves that boundary before the command row, ahead of anything that marks the
 * turn as one Orca already saved.
 */
export function isRecoverableClaudeBoundary(row: Record<string, unknown>): boolean {
  const metadata = row.compactMetadata
  return (
    row.type === 'system' &&
    row.subtype === 'compact_boundary' &&
    typeof metadata === 'object' &&
    metadata !== null &&
    'trigger' in metadata &&
    metadata.trigger === 'auto'
  )
}

export function isCompactionRow(body: AgentJournalItemBody): boolean {
  return body.kind === 'status' && body.presentation === 'compaction'
}

/**
 * Live delivery owns compaction rows in turns Orca saved (older builds wrote none, or a
 * command-keyed /compact row). Catch-up only recovers boundaries from work Orca never saw,
 * so upgraded chats gain neither a duplicate nor a divider below newer saved replies.
 */
export function createTranscriptCompactionRecovery() {
  let savedTurn = false
  const unconfirmed: string[] = []
  const stale = new Set<string>()
  return {
    sawSavedHistory() {
      savedTurn = true
      for (const key of unconfirmed.splice(0)) {
        stale.add(key)
      }
    },
    turnEnded() {
      savedTurn = false
    },
    proposed(key: string, body: AgentJournalItemBody) {
      if (!isCompactionRow(body)) {
        return
      }
      if (savedTurn) {
        stale.add(key)
      } else {
        unconfirmed.push(key)
      }
    },
    /** A saved row keeps its revision; only rows this catch-up would create are withdrawn. */
    withdrawStale(mutations: Map<string, unknown>, saved: (key: string) => unknown) {
      for (const key of stale) {
        if (!saved(key)) {
          mutations.delete(key)
        }
      }
    }
  }
}
