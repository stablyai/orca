export type MobileHistoryScreenView<TRow> =
  | { kind: 'error'; message: string }
  | { kind: 'waiting' }
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'rows'; rows: TRow[] }

// Disconnected cold loads need Retry; keep previously loaded rows visible through outages.
export function resolveMobileHistoryScreenView<TRow>(input: {
  connected: boolean
  rows: TRow[] | null
  error: string | null
}): MobileHistoryScreenView<TRow> {
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
