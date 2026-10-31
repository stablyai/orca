import type { MobileCommitRow } from './mobile-git-history'

export type MobileHistoryScreenView =
  | { kind: 'error'; message: string }
  | { kind: 'waiting' }
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'rows'; rows: MobileCommitRow[] }

// Disconnected cold loads need Retry; keep previously loaded rows visible through outages.
export function resolveMobileHistoryScreenView(input: {
  connected: boolean
  rows: MobileCommitRow[] | null
  error: string | null
}): MobileHistoryScreenView {
  const { connected, rows, error } = input
  if (error) {
    return { kind: 'error', message: error }
  }
  if (rows !== null) {
    return rows.length === 0 ? { kind: 'empty' } : { kind: 'rows', rows }
  }
  if (!connected) {
    return { kind: 'waiting' }
  }
  return { kind: 'loading' }
}
