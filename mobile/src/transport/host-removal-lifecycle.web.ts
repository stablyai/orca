// Web sibling: the page never removes a host — `page-host-removal-refusal.ts` says why. Refusing
// here is also the fence that keeps `push-registration.ts` out of the page bundle: the native
// file's import of it is that subsystem's only path into a page route, and the page has neither
// the device token nor the gateway client it needs.
import { PageHostRemovalUnavailableError } from './page-host-removal-refusal'

export function removeHostAndCloseClient(
  _hostId: string,
  _forgetHostClient: (hostId: string) => void
): Promise<void> {
  return Promise.reject(new PageHostRemovalUnavailableError())
}
