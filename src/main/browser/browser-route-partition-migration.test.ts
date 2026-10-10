import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { deriveBrowserRoutePartition } from './browser-route-identity'
import { BrowserRoutePartitionBindingStore } from './browser-route-partition-binding-store'
import { resolveBrowserRoutePartitionBinding } from './browser-route-partition-migration'
import {
  BrowserRouteSessionRegistry,
  type BrowserRouteElectronSession
} from './browser-route-session-registry'

const orcaProfileId = 'orca/profile:alpha'
const browserProfileId = 'default'
const storageScope = 'e'.repeat(64)
const identity = {
  orcaProfileId,
  browserProfileId,
  authorityConnectionIdentity: 'paired-runtime:durable-authority',
  executionHostIdentity: '["orca-browser-execution-host-storage",1,"authority","env-a"]'
}

/** Identity an older build derived, embedding the remote's per-process runtimeId. */
function legacyIdentityFor(runtimeId: string): typeof identity {
  return {
    orcaProfileId,
    browserProfileId,
    authorityConnectionIdentity: `paired-runtime:authority-with-${runtimeId}`,
    executionHostIdentity: `["orca-browser-execution-host-storage",1,"native","${runtimeId}"]`
  }
}

function createStorePath(): string {
  return join(
    realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'orca-browser-partition-migration-'))),
    'bindings.json'
  )
}

function createSessionRegistry(filePath: string): BrowserRouteSessionRegistry {
  const routeSession: BrowserRouteElectronSession = {
    setProxy: vi.fn(async () => {}),
    closeAllConnections: vi.fn(async () => {}),
    resolveProxy: vi.fn(async () => 'SOCKS5 127.0.0.1:43123')
  }
  const store = new BrowserRoutePartitionBindingStore({ filePath })
  return new BrowserRouteSessionRegistry({
    validateProfile: vi.fn(),
    getSession: () => routeSession,
    setupPolicies: vi.fn(),
    clearPolicies: vi.fn(),
    retirePageAuthority: vi.fn(() => true),
    // Why: the shipping adapter forwards to one persisted store, so the test uses the real one.
    bindingStore: {
      get: (partition) => store.get(partition),
      set: (partition, fingerprint, scope) => store.set(partition, fingerprint, scope),
      touch: (partition) => store.touch(partition),
      findPartitionByFingerprint: (fingerprint) => store.findPartitionByFingerprint(fingerprint),
      rebind: (partition, fingerprint, scope) => store.rebind(partition, fingerprint, scope)
    }
  })
}

/** One full client-hosted page preparation, released again so the partition is not retained. */
async function preparePartition(
  registry: BrowserRouteSessionRegistry,
  legacyRuntimeId: string | null
): Promise<string> {
  const handle = await registry.preparePage({
    identity,
    ...(legacyRuntimeId === null ? {} : { legacyIdentity: legacyIdentityFor(legacyRuntimeId) }),
    storageScope,
    browserPageId: 'page-a',
    pageHostGeneration: 1,
    rendererWebContentsId: 11,
    proxyEndpoint: { host: '127.0.0.1', port: 43123 }
  })
  const partition = handle.partition
  handle.release()
  return partition
}

/** What an older build persisted: a partition named from the then-current runtimeId. */
function seedLegacyBinding(filePath: string, runtimeId: string): string {
  const derived = deriveBrowserRoutePartition(legacyIdentityFor(runtimeId))
  new BrowserRoutePartitionBindingStore({ filePath }).set(
    derived.partition,
    derived.bindingFingerprint,
    storageScope
  )
  return derived.partition
}

function bindings(filePath: string): ReturnType<BrowserRoutePartitionBindingStore['listBindings']> {
  return new BrowserRoutePartitionBindingStore({ filePath }).listBindings()
}

describe('route partition identity migration', () => {
  it('keeps an upgraded client on the partition its cookies already live in', async () => {
    const filePath = createStorePath()
    const legacyPartition = seedLegacyBinding(filePath, 'runtime-before-upgrade')

    const prepared = await preparePartition(
      createSessionRegistry(filePath),
      'runtime-before-upgrade'
    )

    expect(prepared).toBe(legacyPartition)
    expect(bindings(filePath).size).toBe(1)
    // The binding now answers to the durable fingerprint, so the legacy name is never needed again.
    expect(bindings(filePath).get(legacyPartition)?.fingerprint).toBe(
      deriveBrowserRoutePartition(identity).bindingFingerprint
    )
  })

  it('keeps the adopted partition after the remote server restarts under a new runtimeId', async () => {
    const filePath = createStorePath()
    const legacyPartition = seedLegacyBinding(filePath, 'runtime-before-upgrade')
    await preparePartition(createSessionRegistry(filePath), 'runtime-before-upgrade')

    const afterRestart = await preparePartition(
      createSessionRegistry(filePath),
      'runtime-after-restart'
    )

    expect(afterRestart).toBe(legacyPartition)
    expect(bindings(filePath).size).toBe(1)
  })

  it('mints one durable partition for a fresh install and reuses it across restarts', async () => {
    const filePath = createStorePath()

    const first = await preparePartition(createSessionRegistry(filePath), 'runtime-one')
    const second = await preparePartition(createSessionRegistry(filePath), 'runtime-two')

    expect(first).toBe(deriveBrowserRoutePartition(identity).partition)
    expect(second).toBe(first)
    expect(bindings(filePath).size).toBe(1)
  })

  // Why: the derived name is already taken, so walking off to the pre-migration partition
  // would abandon a jar this identity holds and leave it behind as an orphan.
  it('never leaves a partition name this identity already holds', () => {
    const legacyIdentity = legacyIdentityFor('runtime-before-upgrade')
    const derived = deriveBrowserRoutePartition(identity)
    const legacy = deriveBrowserRoutePartition(legacyIdentity)
    const rebound: string[] = []

    const resolved = resolveBrowserRoutePartitionBinding({
      bindings: {
        get: (partition) =>
          partition === derived.partition
            ? 'f'.repeat(64)
            : partition === legacy.partition
              ? legacy.bindingFingerprint
              : null,
        findPartitionByFingerprint: () => null,
        rebind: (partition) => rebound.push(partition)
      },
      identity,
      legacyIdentity,
      storageScope
    })

    expect(resolved).toEqual(derived)
    expect(rebound).toEqual([])
  })

  it('never adopts a partition another route already owns', async () => {
    const filePath = createStorePath()
    const otherLegacy = legacyIdentityFor('runtime-before-upgrade')
    const derivedOther = deriveBrowserRoutePartition(otherLegacy)
    // Why: same partition name, a fingerprint from some other identity -- adoption must decline.
    new BrowserRoutePartitionBindingStore({ filePath }).set(
      derivedOther.partition,
      'c'.repeat(64),
      storageScope
    )

    const prepared = await preparePartition(
      createSessionRegistry(filePath),
      'runtime-before-upgrade'
    )

    expect(prepared).toBe(deriveBrowserRoutePartition(identity).partition)
    expect(bindings(filePath).get(derivedOther.partition)?.fingerprint).toBe('c'.repeat(64))
  })
})
