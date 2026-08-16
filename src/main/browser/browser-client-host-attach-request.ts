import { BrowserClientHostAttachParams } from '../../shared/browser-client-host-protocol'
import { prepareBrowserClientPageInventoryForAttach } from './browser-client-page-inventory'
import type { PairedRuntimeBrowserHostLeaseOptions } from './paired-runtime-browser-host-lease-options'

export function assertBrowserClientHostAttachOptions(
  options: PairedRuntimeBrowserHostLeaseOptions
): void {
  if (
    (options.pageInventoryProtocolVersion === undefined) !==
    (options.getPageInventory === undefined)
  ) {
    throw new Error('Browser host page inventory negotiation is incomplete')
  }
}

export function createBrowserClientHostAttachRequest(
  options: PairedRuntimeBrowserHostLeaseOptions
) {
  const pageCommandProtocolVersion = options.onPageCommand
    ? options.pageCommandProtocolVersion
    : undefined
  const pageInventory = options.getPageInventory
    ? prepareBrowserClientPageInventoryForAttach(options.getPageInventory())
    : undefined
  const pageInventoryProtocolVersion = pageInventory
    ? options.pageInventoryProtocolVersion
    : undefined
  const params = BrowserClientHostAttachParams.parse({
    authorityRuntimeId: options.authorityRuntimeId,
    browserHostClientId: options.browserHostClientId,
    hostCapabilities: [...options.hostCapabilities],
    ...(pageCommandProtocolVersion ? { pageCommandProtocolVersion } : {}),
    ...(pageInventoryProtocolVersion
      ? {
          pageInventoryProtocolVersion,
          pageInventory
        }
      : {})
  })
  return { pageCommandProtocolVersion, pageInventoryProtocolVersion, params }
}
