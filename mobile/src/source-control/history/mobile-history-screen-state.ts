export type MobileHistoryScreenView<Row> =
  | { kind: 'error'; message: string }
  | { kind: 'waiting' }
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'rows'; rows: Row[] }

// Disconnected cold loads need Retry; keep previously loaded rows visible through outages.
export function resolveMobileHistoryScreenView<Row>(input: {
  connected: boolean
  rows: Row[] | null
  error: string | null
}): MobileHistoryScreenView<Row> {
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
