import type { ConnectionState } from '../transport/connection/connection-state'
import { isHostNotConnectedError } from './host-query-errors'

export type HostScreenState =
  | 'data'
  | 'empty-loading'
  | 'empty-connecting'
  | 'empty-offline'
  | 'empty-error'

// A screen with data shows it whatever the connection; an empty one says why, and spins only while a read can land.
export function hostScreenState(
  result: { data: unknown; error: unknown; isFetching: boolean },
  connState: ConnectionState
): HostScreenState {
  if (result.data !== undefined) {
    return 'data'
  }
  if (connState === 'disconnected' || connState === 'auth-failed') {
    return 'empty-offline'
  }
  if (connState !== 'connected') {
    return 'empty-connecting'
  }
  if (result.isFetching) {
    return 'empty-loading'
  }
  // The connected edge's refetch has not started yet.
  if (isHostNotConnectedError(result.error)) {
    return 'empty-connecting'
  }
  return result.error ? 'empty-error' : 'empty-loading'
}
