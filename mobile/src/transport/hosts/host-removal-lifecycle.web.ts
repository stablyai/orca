// Refuse page-side host removal and keep native push-registration imports outside the bundle; the page has no credential/gateway client.
import { PageHostRemovalUnavailableError } from './page-host-removal-refusal'

export function removeHostAndCloseClient(
  _hostId: string,
  _forgetHostClient: (hostId: string) => void
): Promise<void> {
  return Promise.reject(new PageHostRemovalUnavailableError())
}
