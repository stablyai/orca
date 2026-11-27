import {
  isConnectionDialing,
  isConnectionOutage,
  type ConnectionVerdict
} from '../../transport/connection/connection-health'
import type { ConnectionState } from '../../transport/connection/connection-state'

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
): 'loading' | 'unreachable' | 'catalog-error' | 'empty' | 'auth-failed' | null {
  const {
    connState,
    connectionVerdict,
    worktreesLoaded,
    displayCount,
    sectionCount,
    catalogError
  } = input
  // A refused pairing replaces the list: nothing on it can be opened until the phone pairs again.
  if (connectionVerdict.kind === 'auth-failed') {
    return 'auth-failed'
  }
  // An outage with nothing cached must say so; a spinner there never ends (STA-11382).
  if (
    displayCount === 0 &&
    (isConnectionOutage(connectionVerdict) ||
      (connState === 'disconnected' && !isConnectionDialing(connectionVerdict)))
  ) {
    return 'unreachable'
  }
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
