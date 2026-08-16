import { app, session } from 'electron'
import { join } from 'node:path'
import { BrowserRoutePartitionBindingStore } from './browser-route-partition-binding-store'
import { BrowserRouteSessionRegistry } from './browser-route-session-registry'
import { BrowserRouteWebContentsRegistry } from './browser-route-webcontents-registry'
import { browserSessionRegistry } from './browser-session-registry'

const BINDING_FILE_NAME = 'browser-route-partition-bindings.json'
const PARTITION_DATA_DIRECTORY_NAME = 'Partitions'
let bindingFilePathOverride: string | null = null
const routeWebContentsRegistryRef: {
  current: BrowserRouteWebContentsRegistry | null
} = { current: null }

const bindingStore = {
  get(partition: string): string | null {
    return currentBindingStore().get(partition)
  },
  set(partition: string, fingerprint: string): void {
    currentBindingStore().set(partition, fingerprint)
  }
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
  bindingStore
})

export const browserRouteWebContentsRegistry = new BrowserRouteWebContentsRegistry({
  getPartitionForSession: (routeSession) =>
    browserRouteSessionRegistry.getPartitionForSession(routeSession),
  getPreparedPageAuthority: (page) => browserRouteSessionRegistry.getPreparedPageAuthority(page),
  retirePreparedPage: (page) => browserRouteSessionRegistry.retirePreparedPage(page)
})
routeWebContentsRegistryRef.current = browserRouteWebContentsRegistry

export function configureRouteSessionsForOrcaProfile(options: { profileDirectory: string }): void {
  bindingFilePathOverride = join(options.profileDirectory, BINDING_FILE_NAME)
}

function currentBindingStore(): BrowserRoutePartitionBindingStore {
  return new BrowserRoutePartitionBindingStore({
    filePath: bindingFilePathOverride ?? join(app.getPath('userData'), BINDING_FILE_NAME),
    partitionDataRoot: join(app.getPath('userData'), PARTITION_DATA_DIRECTORY_NAME)
  })
}
