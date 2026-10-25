import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'

type InventoryRefreshState = {
  closed: boolean
  reconnectPromise: Promise<void> | null
  supportsInventoryRefresh: boolean
  connection: { active: boolean; fail(error: Error): void } | null
}

/** Force reattach because page inventory is published only in the attach handshake. */
export function requestBrowserHostLeaseInventoryRefresh(
  state: InventoryRefreshState,
  reconnectPromise: () => Promise<void> | null
): Promise<void> {
  if (state.closed) {
    return Promise.reject(new Error('Browser host lease is closed'))
  }
  if (state.reconnectPromise) {
    return state.reconnectPromise
  }
  if (!state.supportsInventoryRefresh) {
    return Promise.reject(new Error('Browser host inventory refresh is unavailable'))
  }
  if (!state.connection?.active) {
    return Promise.reject(new Error('Browser host lease connection is unavailable'))
  }
  state.connection.fail(
    new RemoteRuntimeClientError(
      'remote_runtime_unavailable',
      'Browser host page inventory refresh requested.'
    )
  )
  return (
    reconnectPromise() ?? Promise.reject(new Error('Browser host inventory refresh did not start'))
  )
}
