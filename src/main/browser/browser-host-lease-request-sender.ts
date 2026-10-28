import type { RemoteRuntimeSubscription } from '../../shared/remote-runtime/remote-runtime-client'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime/remote-runtime-client-error'

/** Page traffic must use the lease's connection; ordinary runtime calls are rejected as stale. */
export function requireBrowserHostLeaseSendRequest(
  sendRequest: RemoteRuntimeSubscription['sendRequest'] | undefined,
  unavailableMessage: string
): NonNullable<RemoteRuntimeSubscription['sendRequest']> {
  if (!sendRequest) {
    throw new RemoteRuntimeClientError('remote_runtime_unavailable', unavailableMessage)
  }
  return sendRequest
}
