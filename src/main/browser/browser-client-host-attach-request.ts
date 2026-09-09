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
  if (
    options.leaseReconnectProtocolVersion !== undefined &&
    options.pageInventoryProtocolVersion === undefined
  ) {
    throw new Error('Browser host reconnect requires page inventory negotiation')
  }
  if (
    options.pageReconciliationProtocolVersion !== undefined &&
    (options.pageCommandProtocolVersion !== 1 ||
      options.onPageCommand === undefined ||
      options.pageInventoryProtocolVersion !== 1 ||
      options.getPageInventory === undefined)
  ) {
    throw new Error('Browser page reconciliation requires command and inventory negotiation')
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
  const leaseReconnectProtocolVersion = pageInventoryProtocolVersion
    ? options.leaseReconnectProtocolVersion
    : undefined
  const pageReconciliationProtocolVersion =
    pageCommandProtocolVersion && pageInventoryProtocolVersion
      ? options.pageReconciliationProtocolVersion
      : undefined
  const fileChannelProtocolVersion = pageCommandProtocolVersion
    ? options.fileChannelProtocolVersion
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
      : {}),
    ...(leaseReconnectProtocolVersion ? { leaseReconnectProtocolVersion } : {}),
    ...(pageReconciliationProtocolVersion ? { pageReconciliationProtocolVersion } : {}),
    ...(fileChannelProtocolVersion ? { fileChannelProtocolVersion } : {})
  })
  return {
    pageCommandProtocolVersion,
    pageInventoryProtocolVersion,
    leaseReconnectProtocolVersion,
    pageReconciliationProtocolVersion,
    fileChannelProtocolVersion,
    params
  }
}
