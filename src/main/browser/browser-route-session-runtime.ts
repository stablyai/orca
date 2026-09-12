import { session, webContents } from 'electron'
import { setBrowserClientRouteWebContentsProbe } from './browser-client-download-routing'
import type { BrowserRoutePartitionBindingStore } from './browser-route-partition-binding-store'
import {
  configureBrowserRoutePartitionBindingsForOrcaProfile,
  currentBrowserRoutePartitionBindingStore
} from './browser-route-partition-binding-runtime'
import { releaseEvictedBrowserRoutePartitionStorage } from './browser-route-partition-storage-dependencies'
import { isBrowserRouteGuestPopup } from './browser-route-guest-popup-ownership'
import { browserManager } from './browser-manager'
import {
  isBrowserRoutePartitionRetainedByAnyOwner,
  registerBrowserRoutePartitionRetentionProbe
} from './browser-route-partition-retention'
import { BrowserRouteSessionRegistry } from './browser-route-session-registry'
import { BrowserRouteWebContentsRegistry } from './browser-route-webcontents-registry'
import { browserSessionRegistry } from './browser-session-registry'

const routeWebContentsRegistryRef: {
  current: BrowserRouteWebContentsRegistry | null
} = { current: null }

// Why: a retained partition's storage is in use right now, so eviction must never pick it.
const currentBindingStore = (): BrowserRoutePartitionBindingStore =>
  currentBrowserRoutePartitionBindingStore({
    isPartitionRetained: isBrowserRoutePartitionRetainedByAnyOwner
  })

const bindingStore = {
  get: (partition: string): string | null => currentBindingStore().get(partition),
  set: (partition: string, fingerprint: string, storageScope: string): readonly string[] =>
    currentBindingStore().set(partition, fingerprint, storageScope),
  touch: (partition: string): void => currentBindingStore().touch(partition),
  findPartitionByFingerprint: (fingerprint: string): string | null =>
    currentBindingStore().findPartitionByFingerprint(fingerprint),
  rebind: (partition: string, fingerprint: string, storageScope: string): void =>
    currentBindingStore().rebind(partition, fingerprint, storageScope)
}

export const browserRouteSessionRegistry = new BrowserRouteSessionRegistry({
  validateProfile: (browserProfileId) => {
    browserSessionRegistry.requireRouteBrowserProfile(browserProfileId)
  },
  getSession: (partition) => session.fromPartition(partition),
  setupPolicies: ({ partition, browserProfileId }) => {
    browserSessionRegistry.setupRoutePartitionPolicies(partition, browserProfileId)
  },
  clearPolicies: ({ partition }) => {
    browserSessionRegistry.clearRoutePartitionPolicies(partition)
  },
  retirePageAuthority: (retirement) =>
    routeWebContentsRegistryRef.current?.retirePageAuthority(retirement) ?? false,
  bindingStore,
  releaseEvictedPartitions: (partitions) => {
    void releaseEvictedBrowserRoutePartitionStorage(
      partitions,
      isBrowserRoutePartitionRetainedByAnyOwner
    )
  }
})

registerBrowserRoutePartitionRetentionProbe((partition) =>
  browserRouteSessionRegistry.isPartitionRetained(partition)
)

export const browserRouteWebContentsRegistry = new BrowserRouteWebContentsRegistry({
  getPartitionForSession: (routeSession) =>
    browserRouteSessionRegistry.getPartitionForSession(routeSession),
  getPreparedPageAuthority: (page) => browserRouteSessionRegistry.getPreparedPageAuthority(page),
  rekeyPreparedPage: (previous, next) =>
    browserRouteSessionRegistry.rekeyPreparedPage(previous, next),
  retirePreparedPage: (page) => browserRouteSessionRegistry.retirePreparedPage(page),
  retirePreparedPagesOwnedByRenderer: (rendererWebContentsId) =>
    browserRouteSessionRegistry.retirePreparedPagesOwnedByRenderer(rendererWebContentsId),
  reportBlockedPopup: (blocked) => browserManager.reportRouteGuestPopupBlocked(blocked)
})
routeWebContentsRegistryRef.current = browserRouteWebContentsRegistry

// Why: downloads must fail closed for client-hosted content, so the router needs to tell a route
// guest (or one of its popups) from an ordinary browser guest before it decides where bytes land.
setBrowserClientRouteWebContentsProbe((webContentsId) => {
  if (isBrowserRouteGuestPopup(webContentsId)) {
    return true
  }
  const contents = webContents.fromId(webContentsId)
  return Boolean(
    contents &&
    !contents.isDestroyed() &&
    browserRouteSessionRegistry.getPartitionForSession(contents.session) !== null
  )
})

export function configureRouteSessionsForOrcaProfile(options: {
  orcaProfileId: string
  profileDirectory: string
}): void {
  configureBrowserRoutePartitionBindingsForOrcaProfile(options)
}
