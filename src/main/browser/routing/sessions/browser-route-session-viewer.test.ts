// A route partition's routing is decided once: a page asking for the same partition as another
// viewer kind is refused, never handed the other's proxy rules.
import { expect, it } from 'vitest'
import { BrowserRouteSessionRegistry } from './browser-route-session-registry'
import type { BrowserRouteElectronSession } from './browser-route-session-policy'

function routedSession(): BrowserRouteElectronSession {
  let rules = ''
  return {
    setProxy: async (config) => void (rules = config.proxyBypassRules),
    closeAllConnections: async () => {},
    resolveProxy: async (url) =>
      new URL(url).hostname === '127.0.0.1' || !rules.startsWith('*')
        ? 'SOCKS5 127.0.0.1:4100'
        : 'DIRECT'
  }
}

it('refuses a page that asks for a teammate’s partition as one of your own computers', async () => {
  const bindings = new Map<string, string>()
  const registry = new BrowserRouteSessionRegistry({
    validateProfile: () => {},
    getSession: routedSession,
    setupPolicies: () => {},
    clearPolicies: () => {},
    retirePageAuthority: () => true,
    bindingStore: {
      get: (partition) => bindings.get(partition) ?? null,
      set: (partition, fingerprint) => (bindings.set(partition, fingerprint), []),
      touch: () => {},
      findPartitionByFingerprint: () => null,
      rebind: (partition, fingerprint) => void bindings.set(partition, fingerprint)
    }
  })
  const page = (browserPageId: string, viewer?: 'teammate' | 'own-computer') => ({
    identity: {
      orcaProfileId: 'profile',
      browserProfileId: 'default',
      authorityConnectionIdentity: 'authority',
      executionHostIdentity: 'host'
    },
    storageScope: 'scope',
    browserPageId,
    pageHostGeneration: 1,
    rendererWebContentsId: 7,
    proxyEndpoint: { host: '127.0.0.1' as const, port: 4100 },
    ...(viewer ? { viewer } : {})
  })
  await registry.preparePage(page('page-1', 'teammate'))
  await expect(registry.preparePage(page('page-2'))).rejects.toThrow(
    'browser_route_partition_viewer_mismatch'
  )
  await expect(registry.preparePage(page('page-3', 'teammate'))).resolves.toBeTruthy()
})
