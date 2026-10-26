import type { ConnectionState } from '../transport/types'

export type HostWorkspaceListStateInput = {
  connState: ConnectionState
  worktreesLoaded: boolean
  displayCount: number
  sectionCount: number
  catalogError: string | null
}

// A failed catalog must not appear as a healthy empty host (STA-3123).
export function selectHostWorkspaceListState(
  input: HostWorkspaceListStateInput
): 'loading' | 'catalog-error' | 'empty' | null {
  const { connState, worktreesLoaded, displayCount, sectionCount, catalogError } = input
  // Let the header escalate disconnected outages; do not present them as empty workspace lists.
  const pending =
    connState === 'connecting' ||
    connState === 'handshaking' ||
    connState === 'reconnecting' ||
    connState === 'disconnected'
  if (
    (pending && displayCount === 0) ||
    (connState === 'connected' && !worktreesLoaded && displayCount === 0 && !catalogError)
  ) {
    return 'loading'
  }
  if (connState !== 'connected') {
    return null
  }
  if (catalogError && displayCount === 0) {
    return 'catalog-error'
  }
  if (worktreesLoaded && sectionCount === 0) {
    return 'empty'
  }
  return null
}
