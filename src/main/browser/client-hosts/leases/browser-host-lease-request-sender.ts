import type { RemoteRuntimeTransportSubscription } from '../../../../shared/remote-runtime/requests/remote-runtime-subscription-contract'
import { RemoteRuntimeClientError } from '../../../../shared/remote-runtime/remote-runtime-client-error'

/** Page traffic must use the lease's connection; ordinary runtime calls are rejected as stale. */
export function requireBrowserHostLeaseSendRequest(
  sendRequest: RemoteRuntimeTransportSubscription['sendRequest'] | undefined,
  unavailableMessage: string
): NonNullable<RemoteRuntimeTransportSubscription['sendRequest']> {
  if (!sendRequest) {
    throw new RemoteRuntimeClientError('remote_runtime_unavailable', unavailableMessage)
  }
  return sendRequest
}
