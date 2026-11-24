import type { ClaudeImportFieldFragment } from './history-import/journal-claude-import-worker-protocol'
import { journalRecoveryPageEntriesBytes } from './journal-sql-reader-reply-limit'

type Kind = 'claude-recovery-origin' | 'claude-recovery-slices'
export type ClaudeRecoveryPosition = { ordinal: number; offset: number }
export type ClaudeRecoveryFragment = {
  entry: ClaudeImportFieldFragment
  size: number
  at: ClaudeRecoveryPosition
}

export function claudeRecoveryFragmentBytes(kind: Kind): number {
  return journalRecoveryPageEntriesBytes({
    kind,
    fragments: [],
    next: { ordinal: Number.MAX_SAFE_INTEGER, offset: Number.MAX_SAFE_INTEGER }
  })
}

export function readClaudeRecoveryFragmentPage(
  available: Iterator<ClaudeRecoveryFragment>,
  budget: number,
  pending = available.next()
) {
  const fragments: ClaudeImportFieldFragment[] = []
  let bytes = 0
  while (!pending.done && bytes + pending.value.size <= budget) {
    const { entry, size } = pending.value
    fragments.push(entry)
    bytes += size
    pending = available.next()
  }
  return { fragments, next: pending.done ? null : pending.value.at, pending }
}
