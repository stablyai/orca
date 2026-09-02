import type { MobileCommitRow } from './mobile-git-history'

export type MobileHistoryScreenView =
  | { kind: 'error'; message: string }
  | { kind: 'waiting' }
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'rows'; rows: MobileCommitRow[] }

// Why: the history load effect no-ops while the client isn't connected, so
// without an explicit 'waiting' view the screen showed an infinite spinner
// with no retry when opened during a reconnect window (STA-1511). Rows loaded
// before a drop stay visible — stale history beats a blank screen.
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
