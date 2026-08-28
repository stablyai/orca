import { describe, expect, it, vi } from 'vitest'
import type {
  BrowserHostLeaseAuthority,
  BrowserNetworkExecutionHost
} from '../../shared/browser-client-host-protocol'

const {
  bindingStore,
  detectInstalledBrowsersMock,
  getProfileMock,
  getRouteIdentityMock,
  importCookiesFromBrowserMock,
  requireRouteBrowserProfileMock,
  updateProfileSourceMock
} = vi.hoisted(() => ({
  bindingStore: {
    get: vi.fn(() => null as string | null),
    set: vi.fn(() => [] as readonly string[]),
    touch: vi.fn(),
    findPartitionByFingerprint: vi.fn(() => null as string | null),
    rebind: vi.fn()
  },
  detectInstalledBrowsersMock: vi.fn(),
  getProfileMock: vi.fn(),
  getRouteIdentityMock: vi.fn(),
  importCookiesFromBrowserMock: vi.fn(),
  requireRouteBrowserProfileMock: vi.fn(),
  updateProfileSourceMock: vi.fn()
}))

vi.mock('./browser-cookie-import', () => ({
  detectInstalledBrowsers: detectInstalledBrowsersMock,
  importCookiesFromBrowser: importCookiesFromBrowserMock,
  selectBrowserProfile: vi.fn()
}))
vi.mock('./browser-route-partition-binding-runtime', () => ({
  currentBrowserRoutePartitionBindingStore: () => bindingStore
}))
vi.mock('./browser-session-registry', () => ({
  browserSessionRegistry: {
    getProfile: getProfileMock,
    requireRouteBrowserProfile: requireRouteBrowserProfileMock,
    updateProfileSource: updateProfileSourceMock
  }
}))
vi.mock('./paired-runtime-browser-client-host-runtime', () => ({
  getPairedRuntimeBrowserClientRouteIdentity: getRouteIdentityMock
}))

import { importCookiesIntoClientRoutePartition } from './browser-client-route-cookie-import'
import { BrowserClientNetworkRouteRegistry } from './browser-client-network-route-registry'
import {
  browserAuthorityExecutionHostStorageIdentity,
  legacyBrowserNativeExecutionHostStorageIdentity
} from './browser-execution-host-storage-identity'
import { createBrowserRoutePartitionBindingStoreFake } from './browser-route-partition-binding-store-fake'
import { browserNetworkExecutionHostKey } from './browser-network-execution-route'
import {
  BrowserRouteSessionRegistry,
  type BrowserRouteElectronSession
} from './browser-route-session-registry'

const orcaProfileId = 'orca-profile-a'
const browserProfileId = 'default'
const authorityConnectionIdentity = 'paired-runtime:authority-a'
const authorityRuntimeId = 'runtime-a'
const storageScope = 'e'.repeat(64)

const authority: BrowserHostLeaseAuthority = {
  authorityRuntimeId,
  authorityEpoch: 'epoch-a',
  browserHostClientId: 'client-a',
  browserHostGeneration: 1
}

/** The partition an actual client-hosted page ends up in, through the shipping route + session path. */
async function pagePartition(host: BrowserNetworkExecutionHost): Promise<string> {
  const routes = new BrowserClientNetworkRouteRegistry({
    // Why: native/WSL routes are admitted only under their own runtime's authority.
    authority:
      host.kind === 'ssh' ? authority : { ...authority, authorityRuntimeId: host.runtimeId },
    authorityStorageKey: storageScope,
    createRoute: () => ({
      start: vi.fn(async () => ({ host: '127.0.0.1', port: 43123 })),
      reconnect: vi.fn(async () => ({ host: '127.0.0.1', port: 43123 })),
      suspend: vi.fn(),
      close: vi.fn(async () => {})
    })
  })
  const route = await routes.retain(
    browserNetworkExecutionHostKey(host),
    new AbortController().signal
  )
  const session: BrowserRouteElectronSession = {
    setProxy: vi.fn(async () => {}),
    closeAllConnections: vi.fn(async () => {}),
    resolveProxy: vi.fn(async () => 'SOCKS5 127.0.0.1:43123')
  }
  // Why: no derivePartition override — this is the same default derivation a real page gets.
  const sessions = new BrowserRouteSessionRegistry({
    validateProfile: vi.fn(),
    getSession: () => session,
    setupPolicies: vi.fn(),
    clearPolicies: vi.fn(),
    retirePageAuthority: vi.fn(() => true),
    bindingStore: createBrowserRoutePartitionBindingStoreFake()
  })
  const handle = await sessions.preparePage({
    identity: {
      orcaProfileId,
      browserProfileId,
      authorityConnectionIdentity,
      executionHostIdentity: route.executionHostIdentity
    },
    storageScope,
    browserPageId: 'page-a',
    pageHostGeneration: 1,
    rendererWebContentsId: 11,
    proxyEndpoint: route.proxyEndpoint
  })
  const partition = handle.partition
  handle.release()
  await route.release()
  await routes.close()
  return partition
}

/** The partition a settings-level cookie import writes into, through the shipping import path. */
async function importPartition(): Promise<string> {
  bindingStore.get.mockReturnValue(null)
  getProfileMock.mockReturnValue({ id: browserProfileId, partition: 'persist:legacy-server' })
  detectInstalledBrowsersMock.mockReturnValue([
    { family: 'chrome', label: 'Chrome', profiles: [], selectedProfile: 'Default' }
  ])
  importCookiesFromBrowserMock.mockResolvedValue({ ok: true, summary: { importedCookies: 1 } })
  getRouteIdentityMock.mockReturnValue({
    orcaProfileId,
    authorityConnectionIdentity,
    // Why: mirrors startPairedRuntimeBrowserClientHost — settings-level operations target the
    // server's own machine, so the identity comes from the same helper the host uses.
    executionHostIdentity: browserAuthorityExecutionHostStorageIdentity(storageScope),
    legacyAuthorityConnectionIdentity: 'paired-runtime:legacy-authority-a',
    legacyExecutionHostIdentity:
      legacyBrowserNativeExecutionHostStorageIdentity(authorityRuntimeId),
    storageScope
  })

  const result = await importCookiesIntoClientRoutePartition({
    environmentId: 'env-a',
    browserProfileId,
    browserFamily: 'chrome'
  })

  expect(result).toMatchObject({ ok: true })
  return importCookiesFromBrowserMock.mock.calls.at(-1)?.[1] as string
}

describe('cookie-import target vs. client-hosted page partition', () => {
  it('imports into the same partition a page on the server’s own machine uses', async () => {
    const imported = await importPartition()

    expect(imported).toBe(
      await pagePartition({ kind: 'native', runtimeId: authorityRuntimeId, revision: 1 })
    )
  })

  // Why: records deliberate behavior, not a bug — a settings-level import names the server's own
  // machine, so pages whose workspace lives on a nested SSH target or WSL distro keep their own
  // partitions and are not covered by that import.
  it('does not reach pages hosted on a nested SSH target or WSL distro', async () => {
    const imported = await importPartition()

    expect(imported).not.toBe(
      await pagePartition({
        kind: 'ssh',
        targetId: 'ssh-1700000000-aaa111',
        providerEpoch: 'epoch-1',
        connectionGeneration: 1
      })
    )
    expect(imported).not.toBe(
      await pagePartition({
        kind: 'wsl',
        runtimeId: authorityRuntimeId,
        revision: 1,
        distro: 'Ubuntu'
      })
    )
  })
})
