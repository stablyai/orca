import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  KnownRuntimeEnvironment,
  OrcadDeploymentLink
} from '../../shared/runtime-environments'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() }
}))

type CompositionOptions = { onError(error: Error): void }
const compositions: { options: CompositionOptions; closed: Error[] }[] = []

vi.mock('./paired-runtime-browser-client-host-composition', () => ({
  PairedRuntimeBrowserClientHostComposition: class {
    private readonly record: { options: CompositionOptions; closed: Error[] }

    constructor(options: CompositionOptions) {
      this.record = { options, closed: [] }
      compositions.push(this.record)
    }

    start(): Promise<unknown> {
      return Promise.resolve({ authority: 'lease-a' })
    }

    replaceAuthority(): Promise<unknown> {
      return Promise.resolve({ authority: 'lease-a' })
    }

    close(error?: Error): Promise<boolean> {
      if (error) {
        this.record.closed.push(error)
      }
      return Promise.resolve(true)
    }

    whenClosed(): Promise<void> {
      return Promise.resolve()
    }
  }
}))

import { deriveBrowserRoutePartition } from './browser-route-identity'
import { BrowserRoutePartitionBindingStore } from './browser-route-partition-binding-store'
import { resolveBrowserRoutePartitionBinding } from './browser-route-partition-migration'
import {
  configurePairedRuntimeBrowserClientHostsForOrcaProfile,
  getPairedRuntimeBrowserClientRouteIdentity,
  startPairedRuntimeBrowserClientHost,
  type ClientHostRouteIdentity
} from './paired-runtime-browser-client-host-runtime'

const SSH_DEPLOYMENT: OrcadDeploymentLink = {
  sshTargetId: 'target-a',
  sshTargetGeneration: 1,
  localPort: 9999,
  remotePort: 7777
}
const WSL_DEPLOYMENT: OrcadDeploymentLink = {
  kind: 'wsl',
  distro: 'Ubuntu',
  localPort: 9999,
  remotePort: 7777
}

function pairedEnvironment(
  id: string,
  overrides: {
    pairingRevision?: number
    publicKeyB64?: string
    pairedDeviceId?: string
    deviceToken?: string
    orcadDeployment?: OrcadDeploymentLink
  } = {}
): KnownRuntimeEnvironment {
  return {
    id,
    name: `Environment ${id}`,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    ...(overrides.pairingRevision === undefined
      ? {}
      : { pairingRevision: overrides.pairingRevision }),
    ...(overrides.pairedDeviceId === undefined ? {} : { pairedDeviceId: overrides.pairedDeviceId }),
    ...(overrides.orcadDeployment === undefined
      ? {}
      : { orcadDeployment: overrides.orcadDeployment }),
    preferredEndpointId: 'endpoint-a',
    endpoints: [
      {
        id: 'endpoint-a',
        kind: 'websocket',
        label: 'Endpoint A',
        endpoint: 'ws://127.0.0.1:9999',
        deviceToken: overrides.deviceToken ?? 'token-a',
        publicKeyB64: overrides.publicKeyB64 ?? 'key-a'
      }
    ]
  }
}

async function routeIdentity(
  environment: KnownRuntimeEnvironment,
  authorityRuntimeId: string
): Promise<ClientHostRouteIdentity> {
  await startPairedRuntimeBrowserClientHost({ environment, authorityRuntimeId })
  const identity = getPairedRuntimeBrowserClientRouteIdentity(environment.id)
  if (!identity) {
    throw new Error('missing route identity')
  }
  return identity
}

/** Authority identity the client host records for `environment` under `authorityRuntimeId`. */
async function connectionIdentity(
  environment: KnownRuntimeEnvironment,
  authorityRuntimeId: string
): Promise<{ current: string; pairing: string; legacy: string }> {
  const identity = await routeIdentity(environment, authorityRuntimeId)
  return {
    current: identity.authorityConnectionIdentity,
    pairing: identity.pairingAuthorityConnectionIdentity,
    legacy: identity.legacyAuthorityConnectionIdentity
  }
}

function pageIdentity(
  identity: ClientHostRouteIdentity,
  authorityConnectionIdentity: string,
  executionHostIdentity: string
) {
  return {
    orcaProfileId: identity.orcaProfileId,
    browserProfileId: 'default',
    authorityConnectionIdentity,
    executionHostIdentity
  }
}

/** Partition a page for `identity` lands in, resolved the way page creation does it. */
function resolvePartition(filePath: string, identity: ClientHostRouteIdentity): string {
  const store = new BrowserRoutePartitionBindingStore({ filePath })
  const derived = resolveBrowserRoutePartitionBinding({
    bindings: store,
    identity: pageIdentity(
      identity,
      identity.authorityConnectionIdentity,
      identity.executionHostIdentity
    ),
    compatibleIdentity: pageIdentity(
      identity,
      identity.pairingAuthorityConnectionIdentity,
      identity.executionHostIdentity
    ),
    legacyIdentity: pageIdentity(
      identity,
      identity.legacyAuthorityConnectionIdentity,
      identity.legacyExecutionHostIdentity
    ),
    storageScope: identity.storageScope
  })
  const persisted = store.get(derived.partition)
  if (persisted === null) {
    store.set(
      derived.partition,
      derived.bindingFingerprint,
      identity.storageScope,
      derived.aliasFingerprint
    )
  } else if (persisted !== derived.bindingFingerprint) {
    throw new Error('browser_route_partition_binding_conflict')
  }
  return derived.partition
}

/** The shipping build: derives from the pairing identity and reads only `fingerprint`. */
function resolvePartitionAsOlderBuild(filePath: string, identity: ClientHostRouteIdentity): string {
  const derived = deriveBrowserRoutePartition(
    pageIdentity(
      identity,
      identity.pairingAuthorityConnectionIdentity,
      identity.executionHostIdentity
    )
  )
  const persisted: { bindings: Record<string, { fingerprint: string }> } = JSON.parse(
    readFileSync(filePath, 'utf8')
  )
  const bound = Object.entries(persisted.bindings).find(
    ([, binding]) => binding.fingerprint === derived.bindingFingerprint
  )
  if (bound) {
    return bound[0]
  }
  if (persisted.bindings[derived.partition] !== undefined) {
    throw new Error('browser_route_partition_binding_conflict')
  }
  return derived.partition
}

/** An older build's rewrite: its parser keeps only the fields it knows. */
function rewriteAsOlderBuild(filePath: string): void {
  const persisted: {
    version: number
    bindings: Record<string, { fingerprint: string; storageScope: string; lastUsedAt: number }>
  } = JSON.parse(readFileSync(filePath, 'utf8'))
  const bindings = Object.fromEntries(
    Object.entries(persisted.bindings).map(([partition, binding]) => [
      partition,
      {
        fingerprint: binding.fingerprint,
        storageScope: binding.storageScope,
        lastUsedAt: binding.lastUsedAt
      }
    ])
  )
  writeFileSync(filePath, JSON.stringify({ version: persisted.version, bindings }))
}

/** Seeds the jar an older build minted from `identity`'s pairing. */
function seedOlderBuildJar(filePath: string, identity: ClientHostRouteIdentity): string {
  const derived = deriveBrowserRoutePartition(
    pageIdentity(
      identity,
      identity.pairingAuthorityConnectionIdentity,
      identity.executionHostIdentity
    )
  )
  new BrowserRoutePartitionBindingStore({ filePath }).set(
    derived.partition,
    derived.bindingFingerprint,
    identity.storageScope
  )
  return derived.partition
}

function bindingStorePath(): string {
  return join(
    realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'orca-re-pair-partition-'))),
    'bindings.json'
  )
}

beforeEach(() => {
  compositions.length = 0
})

describe('client host authority connection identity', () => {
  // Why: authorityRuntimeId is a per-process UUID. Hashing it into the current identity is the
  // regression that minted a fresh partition on every remote restart and logged the user out.
  it('survives the remote restarting, and keeps the pre-migration identity distinct', async () => {
    configurePairedRuntimeBrowserClientHostsForOrcaProfile({ orcaProfileId: 'profile-a' })
    const environment = pairedEnvironment('environment-restart')

    const before = await connectionIdentity(environment, 'runtime-a')
    const after = await connectionIdentity(environment, 'runtime-restarted')

    expect(after.current).toBe(before.current)
    expect(after.legacy).not.toBe(before.legacy)
    expect(before.legacy).not.toBe(before.current)
  })

  // Why: each of these names a different server or a different trust decision, so sharing an
  // identity would serve one of them the other's cookies.
  it('separates environments, pairing revisions, and server keys', async () => {
    configurePairedRuntimeBrowserClientHostsForOrcaProfile({ orcaProfileId: 'profile-a' })
    const identities = [
      await connectionIdentity(pairedEnvironment('environment-a'), 'runtime-a'),
      await connectionIdentity(pairedEnvironment('environment-b'), 'runtime-a'),
      await connectionIdentity(
        pairedEnvironment('environment-a', { pairingRevision: 2 }),
        'runtime-a'
      ),
      await connectionIdentity(
        pairedEnvironment('environment-a', { publicKeyB64: 'key-rotated' }),
        'runtime-a'
      )
    ]

    expect(new Set(identities.map((entry) => entry.current)).size).toBe(identities.length)
  })
})

describe('client host identity for a server Orca re-pairs in place', () => {
  it.each([
    ['managed SSH', SSH_DEPLOYMENT],
    ['WSL', WSL_DEPLOYMENT]
  ])('%s keeps one identity across re-pairs and still separates keys', async (_, deployment) => {
    configurePairedRuntimeBrowserClientHostsForOrcaProfile({ orcaProfileId: 'profile-a' })
    const id = `environment-${deployment.kind ?? 'ssh'}`
    const before = await connectionIdentity(
      pairedEnvironment(id, { orcadDeployment: deployment, pairedDeviceId: 'device-a' }),
      'runtime-a'
    )
    const rePaired = await connectionIdentity(
      pairedEnvironment(id, {
        orcadDeployment: deployment,
        pairingRevision: 5,
        pairedDeviceId: 'device-b',
        deviceToken: 'token-b'
      }),
      'runtime-b'
    )
    const otherKey = await connectionIdentity(
      pairedEnvironment(id, { orcadDeployment: deployment, publicKeyB64: 'key-b' }),
      'runtime-a'
    )
    const otherEnvironment = await connectionIdentity(
      pairedEnvironment(`${id}-other`, { orcadDeployment: deployment }),
      'runtime-a'
    )

    expect(rePaired.current).toBe(before.current)
    expect(rePaired.pairing).not.toBe(before.pairing)
    expect(otherKey.current).not.toBe(before.current)
    expect(otherEnvironment.current).not.toBe(before.current)
  })

  it('leaves a manually paired server on its pairing identity', async () => {
    configurePairedRuntimeBrowserClientHostsForOrcaProfile({ orcaProfileId: 'profile-a' })
    const identity = await connectionIdentity(pairedEnvironment('environment-manual'), 'runtime-a')

    expect(identity.current).toBe(identity.pairing)
  })

  it.each([
    ['managed SSH', SSH_DEPLOYMENT],
    ['WSL', WSL_DEPLOYMENT]
  ])(
    '%s keeps the jar an older build filled through re-pairs and a downgrade',
    async (_, deployment) => {
      configurePairedRuntimeBrowserClientHostsForOrcaProfile({ orcaProfileId: 'profile-a' })
      const filePath = bindingStorePath()
      const id = `environment-jar-${deployment.kind ?? 'ssh'}`
      const atRevisionOne = await routeIdentity(
        pairedEnvironment(id, { orcadDeployment: deployment, pairedDeviceId: 'device-a' }),
        'runtime-a'
      )
      const atRevisionTwo = await routeIdentity(
        pairedEnvironment(id, {
          orcadDeployment: deployment,
          pairingRevision: 2,
          pairedDeviceId: 'device-b',
          deviceToken: 'token-b'
        }),
        'runtime-b'
      )
      const withNewKey = await routeIdentity(
        pairedEnvironment(id, {
          orcadDeployment: deployment,
          pairingRevision: 3,
          publicKeyB64: 'key-b'
        }),
        'runtime-c'
      )
      const olderJar = seedOlderBuildJar(filePath, atRevisionOne)

      expect(resolvePartition(filePath, atRevisionOne)).toBe(olderJar)
      // Why: a downgraded build reads only `fingerprint`, so it must reopen the same jar.
      expect(resolvePartitionAsOlderBuild(filePath, atRevisionOne)).toBe(olderJar)
      expect(resolvePartition(filePath, atRevisionTwo)).toBe(olderJar)
      // The fingerprint follows the pairing, so a downgrade after the re-pair still finds it.
      expect(resolvePartitionAsOlderBuild(filePath, atRevisionTwo)).toBe(olderJar)
      // An older build's rewrite drops the alias; the next upgrade re-adopts at that pairing.
      rewriteAsOlderBuild(filePath)
      expect(resolvePartition(filePath, atRevisionTwo)).toBe(olderJar)
      // Why: a different server key is a different server, which never inherits the jar.
      expect(resolvePartition(filePath, withNewKey)).not.toBe(olderJar)
    }
  )

  it('mints a fresh jar an older build can open at every pairing', async () => {
    configurePairedRuntimeBrowserClientHostsForOrcaProfile({ orcaProfileId: 'profile-a' })
    const filePath = bindingStorePath()
    const id = 'environment-fresh'
    const atRevisionOne = await routeIdentity(
      pairedEnvironment(id, { orcadDeployment: SSH_DEPLOYMENT, pairedDeviceId: 'device-a' }),
      'runtime-a'
    )
    const atRevisionTwo = await routeIdentity(
      pairedEnvironment(id, {
        orcadDeployment: SSH_DEPLOYMENT,
        pairingRevision: 2,
        pairedDeviceId: 'device-b'
      }),
      'runtime-b'
    )

    const jar = resolvePartition(filePath, atRevisionOne)
    expect(resolvePartitionAsOlderBuild(filePath, atRevisionOne)).toBe(jar)
    expect(resolvePartition(filePath, atRevisionTwo)).toBe(jar)
    expect(resolvePartitionAsOlderBuild(filePath, atRevisionTwo)).toBe(jar)
    // Why: the jar's name is derived from the stable identity, so losing its alias to an
    // older build's rewrite must not turn it into a binding conflict.
    rewriteAsOlderBuild(filePath)
    expect(resolvePartition(filePath, atRevisionOne)).toBe(jar)
    expect(resolvePartitionAsOlderBuild(filePath, atRevisionOne)).toBe(jar)
  })

  it('adopts a per-process jar under the fingerprint an older build reads', async () => {
    configurePairedRuntimeBrowserClientHostsForOrcaProfile({ orcaProfileId: 'profile-a' })
    const filePath = bindingStorePath()
    const identity = await routeIdentity(
      pairedEnvironment('environment-runtime-era', { orcadDeployment: SSH_DEPLOYMENT }),
      'runtime-a'
    )
    const legacy = deriveBrowserRoutePartition(
      pageIdentity(
        identity,
        identity.legacyAuthorityConnectionIdentity,
        identity.legacyExecutionHostIdentity
      )
    )
    new BrowserRoutePartitionBindingStore({ filePath }).set(
      legacy.partition,
      legacy.bindingFingerprint,
      identity.storageScope
    )

    expect(resolvePartition(filePath, identity)).toBe(legacy.partition)
    expect(resolvePartitionAsOlderBuild(filePath, identity)).toBe(legacy.partition)
  })
})

describe('client host route identity lifetime', () => {
  it('stops answering with a route identity once the host is retired by its own error', async () => {
    configurePairedRuntimeBrowserClientHostsForOrcaProfile({ orcaProfileId: 'profile-a' })
    const environment = pairedEnvironment('environment-retired')
    await startPairedRuntimeBrowserClientHost({
      environment,
      authorityRuntimeId: 'runtime-a'
    })
    expect(getPairedRuntimeBrowserClientRouteIdentity(environment.id)).not.toBeNull()

    const failure = new Error('lease fenced')
    compositions.at(-1)?.options.onError(failure)
    await vi.waitFor(() => {
      expect(compositions.at(-1)?.closed).toEqual([failure])
    })

    // Why: a cookie import must fall through to the server RPC, not target the dead partition.
    expect(getPairedRuntimeBrowserClientRouteIdentity(environment.id)).toBeNull()
  })
})
