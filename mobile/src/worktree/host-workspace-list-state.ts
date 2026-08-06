import type { ConnectionState } from '../transport/types'

export type HostWorkspaceListStateInput = {
  connState: ConnectionState
  worktreesLoaded: boolean
  displayCount: number
  sectionCount: number
  catalogError: string | null
}

// Why (STA-3123): one owner for the list's loading/failed/empty precedence, so a
// failed worktree.ps can never render as a healthy host with zero workspaces.
export function selectHostWorkspaceListState(
  input: HostWorkspaceListStateInput
): 'loading' | 'catalog-error' | 'empty' | null {
  const { connState, worktreesLoaded, displayCount, sectionCount, catalogError } = input
  // Why: a blank disconnected list read as "no workspaces"; spin instead — the
  // header verdict owns escalating a long outage. auth-failed keeps its own UI.
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
