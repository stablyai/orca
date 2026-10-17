import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  getPreferredPairedRuntimeConnection,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import {
  browserAuthorityExecutionHostStorageIdentity,
  legacyBrowserNativeExecutionHostStorageIdentity
} from './browser-execution-host-storage-identity'
import {
  deriveBrowserRoutePartition,
  deriveBrowserRoutePartitionStorageScope,
  type BrowserRoutePartitionIdentity
} from './browser-route-identity'
import { BrowserRoutePartitionBindingStore } from './browser-route-partition-binding-store'
import { supersededBrowserRoutePartitionIdentities } from './browser-route-partition-migration'
import { BrowserRouteSessionRegistry } from './browser-route-session-registry'
import type { BrowserRouteElectronSession } from './browser-route-session-policy'
import { derivePairedRuntimeBrowserAuthorityIdentities } from './paired-runtime-browser-authority-identity'
import {
  pairedRuntimeHostEnvironment,
  preW1AuthorityConnectionIdentity,
  WSL_DISTRO_ID_B,
  type PairedRuntimeHostKind
} from './paired-runtime-browser-host-environment-fixture'

const orcaProfileId = 'orca-profile-a'
const browserProfileId = 'default'

/** One desktop's persisted binding file plus the cookie jar Chromium keeps per partition. */
type Desktop = { bindingsPath: string; cookies: Map<string, string[]> }

function createDesktop(): Desktop {
  const directory = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), 'orca-browser-re-pair-migration-'))
  )
  return { bindingsPath: join(directory, 'bindings.json'), cookies: new Map() }
}

function storageScopeOf(environment: KnownRuntimeEnvironment): string {
  return deriveBrowserRoutePartitionStorageScope({ orcaProfileId, environmentId: environment.id })
}

/** Partition an app launch places a page on the server's own machine in, persisting the binding. */
async function launchAndOpenPage(
  desktop: Desktop,
  environment: KnownRuntimeEnvironment,
  authorityRuntimeId: string
): Promise<string> {
  const storageScope = storageScopeOf(environment)
  const authority = derivePairedRuntimeBrowserAuthorityIdentities({
    orcaProfileId,
    environment,
    connection: getPreferredPairedRuntimeConnection(environment),
    authorityRuntimeId
  })
  const executionHostIdentity = browserAuthorityExecutionHostStorageIdentity(storageScope)
  const store = new BrowserRoutePartitionBindingStore({ filePath: desktop.bindingsPath })
  const session: BrowserRouteElectronSession = {
    setProxy: vi.fn(async () => {}),
    closeAllConnections: vi.fn(async () => {}),
    resolveProxy: vi.fn(async () => 'SOCKS5 127.0.0.1:43123')
  }
  const registry = new BrowserRouteSessionRegistry({
    validateProfile: vi.fn(),
    getSession: () => session,
    setupPolicies: vi.fn(),
    clearPolicies: vi.fn(),
    retirePageAuthority: vi.fn(() => true),
    bindingStore: {
      get: (partition) => store.get(partition),
      set: (partition, fingerprint, scope) => store.set(partition, fingerprint, scope),
      touch: (partition) => store.touch(partition),
      findPartitionByFingerprint: (fingerprint) => store.findPartitionByFingerprint(fingerprint),
      rebind: (partition, fingerprint, scope) => store.rebind(partition, fingerprint, scope)
    }
  })
  const handle = await registry.preparePage({
    identity: {
      orcaProfileId,
      browserProfileId,
      authorityConnectionIdentity: authority.authorityConnectionIdentity,
      executionHostIdentity
    },
    legacyIdentities: supersededBrowserRoutePartitionIdentities({
      ...authority,
      orcaProfileId,
      browserProfileId,
      executionHostIdentity,
      legacyExecutionHostIdentity:
        legacyBrowserNativeExecutionHostStorageIdentity(authorityRuntimeId)
    }),
    storageScope,
    browserPageId: 'page-a',
    pageHostGeneration: 1,
    rendererWebContentsId: 11,
    proxyEndpoint: { host: '127.0.0.1', port: 43123 }
  })
  handle.release()
  return handle.partition
}

/** What a build before W1 persisted for `environment`, with the user signed in to a site. */
function seedPreW1Login(desktop: Desktop, environment: KnownRuntimeEnvironment): string {
  const storageScope = storageScopeOf(environment)
  return seedLogin(desktop, storageScope, {
    orcaProfileId,
    browserProfileId,
    authorityConnectionIdentity: preW1AuthorityConnectionIdentity(
      orcaProfileId,
      environment,
      getPreferredPairedRuntimeConnection(environment)
    ),
    executionHostIdentity: browserAuthorityExecutionHostStorageIdentity(storageScope)
  })
}

function seedLogin(
  desktop: Desktop,
  storageScope: string,
  identity: BrowserRoutePartitionIdentity
): string {
  const derived = deriveBrowserRoutePartition(identity)
  new BrowserRoutePartitionBindingStore({ filePath: desktop.bindingsPath }).set(
    derived.partition,
    derived.bindingFingerprint,
    storageScope
  )
  desktop.cookies.set(derived.partition, ['session=signed-in'])
  return derived.partition
}

function rotatingHost(
  kind: PairedRuntimeHostKind,
  revision: number,
  device: string
): KnownRuntimeEnvironment {
  return pairedRuntimeHostEnvironment({ kind, pairingRevision: revision, pairedDeviceId: device })
}

describe('browser logins across a managed host re-pair', () => {
  it.each([
    { kind: 'managed-ssh', rePair: 'an orcad update' },
    { kind: 'wsl', rePair: 'an orcad relaunch' }
  ] as const)('keeps an existing $kind user signed in through $rePair', async ({ kind }) => {
    const desktop = createDesktop()
    const atRevisionN = rotatingHost(kind, 1_000, 'device-a')
    const preW1Partition = seedPreW1Login(desktop, atRevisionN)

    const firstW1Launch = await launchAndOpenPage(desktop, atRevisionN, 'runtime-a')
    const rePaired = rotatingHost(kind, 2_000, 'device-b')
    const afterRePair = await launchAndOpenPage(desktop, rePaired, 'runtime-b')

    expect(firstW1Launch).toBe(preW1Partition)
    expect(afterRePair).toBe(preW1Partition)
    expect(desktop.cookies.get(afterRePair)).toEqual(['session=signed-in'])
    // The pre-W1 scheme would have moved the user to an empty jar here.
    expect(seedPreW1Login(createDesktop(), rePaired)).not.toBe(preW1Partition)
    const persisted = new BrowserRoutePartitionBindingStore({
      filePath: desktop.bindingsPath
    }).listBindings()
    expect([...persisted.keys()]).toEqual([preW1Partition])
  })

  // Why: the browser host starts lazily, so orcad can update and re-pair before any page opens.
  it.each(['managed-ssh', 'wsl'] as const)(
    'adopts the pre-upgrade jar of a %s host that re-paired before the first page opened',
    async (kind) => {
      const desktop = createDesktop()
      const preW1Partition = seedPreW1Login(desktop, rotatingHost(kind, 1_000, 'device-a'))
      const rePairedBeforeFirstPage = pairedRuntimeHostEnvironment({
        kind,
        pairingRevision: 2_000,
        pairedDeviceId: 'device-b',
        previousPairing: { pairingRevision: 1_000, pairedDeviceId: 'device-a' }
      })

      const partition = await launchAndOpenPage(desktop, rePairedBeforeFirstPage, 'runtime-b')
      const afterNextRePair = await launchAndOpenPage(
        desktop,
        pairedRuntimeHostEnvironment({
          kind,
          pairingRevision: 3_000,
          pairedDeviceId: 'device-c',
          previousPairing: { pairingRevision: 2_000, pairedDeviceId: 'device-b' }
        }),
        'runtime-c'
      )

      expect(partition).toBe(preW1Partition)
      expect(afterNextRePair).toBe(preW1Partition)
      expect(desktop.cookies.get(partition)).toEqual(['session=signed-in'])
    }
  )

  // Why: a key change is a different trust decision, so the replaced pairing's jar stays behind.
  it('never adopts the pre-upgrade jar across a server key change', async () => {
    const desktop = createDesktop()
    const preW1Partition = seedPreW1Login(desktop, rotatingHost('managed-ssh', 1_000, 'device-a'))
    const reKeyed = pairedRuntimeHostEnvironment({
      kind: 'managed-ssh',
      pairingRevision: 2_000,
      pairedDeviceId: 'device-b',
      publicKeyB64: 'host-key-b',
      previousPairing: { pairingRevision: 1_000, pairedDeviceId: 'device-a' }
    })

    expect(await launchAndOpenPage(desktop, reKeyed, 'runtime-b')).not.toBe(preW1Partition)
  })

  it.each(['manual', 'plain-ssh'] as const)(
    'leaves a %s host on its pre-W1 partition',
    async (kind) => {
      const desktop = createDesktop()
      const environment = rotatingHost(kind, 1_000, 'device-a')
      const preW1Partition = seedPreW1Login(desktop, environment)

      expect(await launchAndOpenPage(desktop, environment, 'runtime-a')).toBe(preW1Partition)
      expect(await launchAndOpenPage(createDesktop(), environment, 'runtime-a')).toBe(
        preW1Partition
      )
    }
  )

  it('still adopts the runtimeId-scoped partition a much older build minted', async () => {
    const desktop = createDesktop()
    const environment = rotatingHost('managed-ssh', 1_000, 'device-a')
    const connection = getPreferredPairedRuntimeConnection(environment)
    const runtimeScoped = derivePairedRuntimeBrowserAuthorityIdentities({
      orcaProfileId,
      environment,
      connection,
      authorityRuntimeId: 'runtime-old'
    }).legacyAuthorityConnectionIdentity
    const oldPartition = seedLogin(desktop, storageScopeOf(environment), {
      orcaProfileId,
      browserProfileId,
      authorityConnectionIdentity: runtimeScoped,
      executionHostIdentity: legacyBrowserNativeExecutionHostStorageIdentity('runtime-old')
    })

    expect(await launchAndOpenPage(desktop, environment, 'runtime-old')).toBe(oldPartition)
    expect(
      await launchAndOpenPage(desktop, rotatingHost('managed-ssh', 2_000, 'device-b'), 'runtime-b')
    ).toBe(oldPartition)
  })

  // Why: a pre-W1 build already re-pointed the runtimeId-era name at its revision fingerprint.
  it('adopts a partition an earlier migration kept under its older name', async () => {
    const desktop = createDesktop()
    const environment = rotatingHost('wsl', 1_000, 'device-a')
    const storageScope = storageScopeOf(environment)
    const preW1Fingerprint = deriveBrowserRoutePartition({
      orcaProfileId,
      browserProfileId,
      authorityConnectionIdentity: preW1AuthorityConnectionIdentity(
        orcaProfileId,
        environment,
        getPreferredPairedRuntimeConnection(environment)
      ),
      executionHostIdentity: browserAuthorityExecutionHostStorageIdentity(storageScope)
    }).bindingFingerprint
    const runtimeEraName = `persist:orca-browser-v1-${'a'.repeat(64)}`
    new BrowserRoutePartitionBindingStore({ filePath: desktop.bindingsPath }).set(
      runtimeEraName,
      preW1Fingerprint,
      storageScope
    )

    expect(await launchAndOpenPage(desktop, environment, 'runtime-a')).toBe(runtimeEraName)
  })

  it('reclaims the partition when a stale sidecar hides the managed deployment', async () => {
    const desktop = createDesktop()
    const managed = rotatingHost('managed-ssh', 1_000, 'device-a')
    const adopted = await launchAndOpenPage(desktop, managed, 'runtime-a')
    const unlinked = pairedRuntimeHostEnvironment({
      kind: 'plain-ssh',
      id: managed.id,
      pairingRevision: 1_000,
      pairedDeviceId: 'device-a'
    })

    expect(await launchAndOpenPage(desktop, unlinked, 'runtime-a')).toBe(adopted)
    expect(await launchAndOpenPage(desktop, managed, 'runtime-a')).toBe(adopted)
  })
})

describe('browser partitions stay per host', () => {
  it('fails closed for a WSL host without a registration GUID', async () => {
    const desktop = createDesktop()
    const environment = pairedRuntimeHostEnvironment({
      kind: 'wsl',
      distroId: null,
      pairingRevision: 1_000,
      pairedDeviceId: 'device-a'
    })
    const preW1Partition = seedPreW1Login(desktop, environment)

    expect(await launchAndOpenPage(desktop, environment, 'runtime-a')).toBe(preW1Partition)
    const rePaired = pairedRuntimeHostEnvironment({
      kind: 'wsl',
      distroId: null,
      pairingRevision: 2_000,
      pairedDeviceId: 'device-b'
    })
    expect(await launchAndOpenPage(desktop, rePaired, 'runtime-b')).not.toBe(preW1Partition)
  })

  it('never hands a re-imported distro the previous registration’s logins', async () => {
    const desktop = createDesktop()
    const original = rotatingHost('wsl', 1_000, 'device-a')
    const signedIn = await launchAndOpenPage(desktop, original, 'runtime-a')
    desktop.cookies.set(signedIn, ['session=signed-in'])
    const reImported = pairedRuntimeHostEnvironment({
      kind: 'wsl',
      distroId: WSL_DISTRO_ID_B,
      pairingRevision: 2_000,
      pairedDeviceId: 'device-b'
    })

    const partition = await launchAndOpenPage(desktop, reImported, 'runtime-b')

    expect(partition).not.toBe(signedIn)
    expect(desktop.cookies.get(partition)).toBeUndefined()
  })

  it('gives distinct environments and server keys distinct partitions', async () => {
    const desktop = createDesktop()
    const partitions = [
      await launchAndOpenPage(desktop, rotatingHost('managed-ssh', 1_000, 'device-a'), 'r'),
      await launchAndOpenPage(
        desktop,
        pairedRuntimeHostEnvironment({ kind: 'managed-ssh', id: 'environment-b' }),
        'r'
      ),
      await launchAndOpenPage(
        desktop,
        pairedRuntimeHostEnvironment({ kind: 'managed-ssh', publicKeyB64: 'host-key-b' }),
        'r'
      ),
      await launchAndOpenPage(desktop, rotatingHost('wsl', 1_000, 'device-a'), 'r')
    ]

    expect(new Set(partitions).size).toBe(partitions.length)
  })
})
