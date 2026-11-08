import '../../mobile-web-shell/bridge/page-host-profile'
import type { ReportedHostDescriptor } from './host-name-identity'

// Last-known descriptors belong to the native host list.
export function updateHostDescriptor(
  _hostId: string,
  _descriptor: ReportedHostDescriptor
): Promise<void> {
  return Promise.resolve()
}
