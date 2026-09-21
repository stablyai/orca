import { releaseBrowserClientDownloadTransfersForPage } from './browser-client-download-transfer-store'
import { BrowserHostLeaseRegistry } from './browser-host-lease-registry'
import {
  retainRuntimeBrowserClientPageRecord,
  type RuntimeBrowserClientPageReleaseHost
} from './runtime-browser-client-page-release'

const registries = new WeakMap<object, BrowserHostLeaseRegistry>()

export function getBrowserHostLeaseRegistry(
  runtime: { getRuntimeId(): string } & RuntimeBrowserClientPageReleaseHost
): BrowserHostLeaseRegistry {
  let registry = registries.get(runtime)
  if (!registry) {
    registry = new BrowserHostLeaseRegistry({
      authorityRuntimeId: runtime.getRuntimeId(),
      onClientPageReleased: (browserPageId) => {
        void releaseBrowserClientDownloadTransfersForPage(runtime, browserPageId).catch((error) => {
          console.warn('[browser-host-lease] download transfer cleanup failed:', error)
        })
      },
      onClientPageFenced: (browserPageId, placement) => {
        retainRuntimeBrowserClientPageRecord(runtime, browserPageId, placement)
      }
    })
    registries.set(runtime, registry)
  }
  return registry
}
