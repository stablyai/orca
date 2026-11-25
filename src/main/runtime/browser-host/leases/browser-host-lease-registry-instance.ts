import { getRuntimeBrowserPageRegistry } from '../../browser/client-pages/runtime-browser-page-registry'
import { releaseBrowserClientDownloadTransfersForPage } from '../../browser/downloads/browser-client-download-transfer-store'
import { BrowserHostLeaseRegistry } from './browser-host-lease-registry'
import {
  retainRuntimeBrowserClientPageRecord,
  type RuntimeBrowserClientPageReleaseHost
} from '../../browser/client-pages/runtime-browser-client-page-release'

const registries = new WeakMap<object, BrowserHostLeaseRegistry>()

export function getBrowserHostLeaseRegistry(
  runtime: { getRuntimeId(): string } & RuntimeBrowserClientPageReleaseHost
): BrowserHostLeaseRegistry {
  let registry = registries.get(runtime)
  if (!registry) {
    registry = new BrowserHostLeaseRegistry({
      authorityRuntimeId: runtime.getRuntimeId(),
      onClientPageInitializationChanged: (workspaceId) =>
        runtime.notifyMobileSessionTabsChanged?.(workspaceId),
      onClientPageReleased: (browserPageId, pageHostGeneration) => {
        void releaseBrowserClientDownloadTransfersForPage(
          runtime,
          browserPageId,
          pageHostGeneration
        ).catch((error) => {
          console.warn('[browser-host-lease] download transfer cleanup failed:', error)
        })
      },
      onClientPageFenced: (browserPageId, placement) => {
        retainRuntimeBrowserClientPageRecord(runtime, browserPageId, placement)
      }
    })
    registries.set(runtime, registry)
    const owner = registry
    getRuntimeBrowserPageRegistry(runtime).setRetirementListener((page) => {
      owner.cancelClientPageInitialization(page.browserPageId, page.placement)
    })
  }
  return registry
}
