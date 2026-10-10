import type { RemoteRuntimeSubscription } from '../../shared/remote-runtime-client'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'

/**
 * Resolves the sender for traffic that has to ride the lease's own connection, or fails closed.
 *
 * Why it fails rather than falling back to a plain runtime call: the runtime binds page traffic to
 * the connection its lease attached on, so a request sent any other way is refused outright with
 * `browser_host_lease_stale`. Failing here names the missing binding where it is missing, instead of
 * spending a round trip to be told the request could never have worked.
 */
export function requireBrowserHostLeaseSendRequest(
  sendRequest: RemoteRuntimeSubscription['sendRequest'] | undefined,
  unavailableMessage: string
): NonNullable<RemoteRuntimeSubscription['sendRequest']> {
  if (!sendRequest) {
    throw new RemoteRuntimeClientError('remote_runtime_unavailable', unavailableMessage)
  }
  return sendRequest
}
