import { isConnectionOutage, type ConnectionVerdict } from '../transport/connection-health'
import type { ConnectionState } from '../transport/types'

export type HostWorkspaceListStateInput = {
  connState: ConnectionState
  connectionVerdict: ConnectionVerdict
  worktreesLoaded: boolean
  displayCount: number
  sectionCount: number
  catalogError: string | null
}

// A failed catalog must not appear as a healthy empty host (STA-3123).
export function selectHostWorkspaceListState(
  input: HostWorkspaceListStateInput
): 'loading' | 'unreachable' | 'catalog-error' | 'empty' | null {
  const {
    connState,
    connectionVerdict,
    worktreesLoaded,
    displayCount,
    sectionCount,
    catalogError
  } = input
  // An outage with nothing cached must say so; a spinner there never ends (STA-11382).
  if (
    displayCount === 0 &&
    (connState === 'disconnected' || isConnectionOutage(connectionVerdict))
  ) {
    return 'unreachable'
  }
  const pending =
    connState === 'connecting' || connState === 'handshaking' || connState === 'reconnecting'
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
