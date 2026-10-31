import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  KnownRuntimeEnvironment,
  OrcadDeploymentLink
} from '../../shared/runtime-environments'

const bindings = vi.hoisted(() => ({ filePath: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() }
}))
vi.mock('./paired-runtime-browser-client-host-composition', () => ({
  PairedRuntimeBrowserClientHostComposition: class {
    start(): Promise<unknown> {
      return Promise.resolve({ authority: 'lease-a' })
    }
    replaceAuthority(): Promise<unknown> {
      return Promise.resolve({ authority: 'lease-a' })
    }
    close(): Promise<boolean> {
      return Promise.resolve(true)
    }
    whenClosed(): Promise<void> {
      return Promise.resolve()
    }
  }
}))
vi.mock('./browser-route-partition-binding-runtime', async () => {
  const { BrowserRoutePartitionBindingStore } =
    await import('./browser-route-partition-binding-store')
  return {
    currentBrowserRoutePartitionBindingStore: () =>
      new BrowserRoutePartitionBindingStore({ filePath: bindings.filePath })
  }
})
vi.mock('./browser-route-partition-storage-dependencies', () => ({
  releaseEvictedBrowserRoutePartitionStorage: vi.fn(async () => {})
}))

import { BrowserRoutePartitionBindingStore } from './browser-route-partition-binding-store'
import { resolveBrowserRoutePartitionBinding } from './browser-route-partition-migration'
import {
  closePairedRuntimeBrowserClientHostEnvironment,
  configurePairedRuntimeBrowserClientHostsForOrcaProfile,
  getPairedRuntimeBrowserClientRouteIdentity,
  startPairedRuntimeBrowserClientHost,
  type ClientHostRouteIdentity
} from './paired-runtime-browser-client-host-runtime'
import {
  bindWslHostBrowserRoutePartition,
  wslHostBrowserRouteStorage
} from './wsl-host-browser-route-partition'

const ORCA_PROFILE = 'profile-a'
const WSL_DEPLOYMENT: OrcadDeploymentLink = {
  kind: 'wsl',
  distro: 'Ubuntu',
  localPort: 9999,
  remotePort: 7777
}
const SSH_DEPLOYMENT: OrcadDeploymentLink = {
  sshTargetId: 'target-a',
  sshTargetGeneration: 1,
  localPort: 9999,
  remotePort: 7777
}

function environment(
  pairing: { revision: number; device: string },
  orcadDeployment: OrcadDeploymentLink | null = WSL_DEPLOYMENT,
  id = 'wsl:Ubuntu'
): KnownRuntimeEnvironment {
  return {
    id,
    name: 'Ubuntu',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    pairingRevision: pairing.revision,
    pairedDeviceId: pairing.device,
    ...(orcadDeployment ? { orcadDeployment } : {}),
    preferredEndpointId: 'endpoint-a',
    endpoints: [
      {
        id: 'endpoint-a',
        kind: 'websocket',
        label: 'Ubuntu',
        endpoint: 'ws://127.0.0.1:9999',
        deviceToken: `token-${pairing.device}`,
        publicKeyB64: 'host-key-a'
      }
    ]
  }
}

function stableStorage(env: KnownRuntimeEnvironment) {
  const result = wslHostBrowserRouteStorage(ORCA_PROFILE, env)
  if (result.kind !== 'stable') {
    throw new Error(`expected a stable partition, got ${result.reason}`)
  }
  return result.storage
}

async function liveRouteIdentity(
  env: KnownRuntimeEnvironment,
  authorityRuntimeId: string
): Promise<ClientHostRouteIdentity> {
  await startPairedRuntimeBrowserClientHost({ environment: env, authorityRuntimeId })
  const identity = getPairedRuntimeBrowserClientRouteIdentity(env.id)
  await closePairedRuntimeBrowserClientHostEnvironment(env.id)
  if (!identity) {
    throw new Error('missing route identity')
  }
  return identity
}

/** The partition the host's in-app page lands in, resolved the way page creation does it. */
async function pagePartition(
  env: KnownRuntimeEnvironment,
  authorityRuntimeId: string,
  browserProfileId = 'default'
): Promise<string> {
  const identity = await liveRouteIdentity(env, authorityRuntimeId)
  const page = (authorityConnectionIdentity: string, executionHostIdentity: string) => ({
    orcaProfileId: identity.orcaProfileId,
    browserProfileId,
    authorityConnectionIdentity,
    executionHostIdentity
  })
  const store = new BrowserRoutePartitionBindingStore({ filePath: bindings.filePath })
  const derived = resolveBrowserRoutePartitionBinding({
    bindings: store,
    identity: page(identity.authorityConnectionIdentity, identity.executionHostIdentity),
    compatibleIdentity: page(
      identity.pairingAuthorityConnectionIdentity,
      identity.executionHostIdentity
    ),
    legacyIdentity: page(
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

let directory: string

beforeEach(() => {
  configurePairedRuntimeBrowserClientHostsForOrcaProfile({ orcaProfileId: ORCA_PROFILE })
  directory = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'wsl-host-route-')))
  bindings.filePath = join(directory, 'bindings.json')
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('WSL host browser route partition', () => {
  it('is the partition the host pages later use, across an orcad relaunch and re-pair', async () => {
    const seeded = bindWslHostBrowserRoutePartition(
      stableStorage(environment({ revision: 10, device: 'a' })),
      'default'
    )

    const afterRelaunch = await pagePartition(environment({ revision: 20, device: 'b' }), 'rt-b')
    const afterAnother = await pagePartition(environment({ revision: 30, device: 'c' }), 'rt-c')

    expect(afterRelaunch).toBe(seeded)
    expect(afterAnother).toBe(seeded)
    expect(
      bindWslHostBrowserRoutePartition(
        stableStorage(environment({ revision: 40, device: 'd' })),
        'default'
      )
    ).toBe(seeded)
  })

  it('copies into the jar the host already uses instead of starting another', async () => {
    const existing = await pagePartition(environment({ revision: 10, device: 'a' }), 'rt-a')

    expect(
      bindWslHostBrowserRoutePartition(
        stableStorage(environment({ revision: 20, device: 'b' })),
        'default'
      )
    ).toBe(existing)
  })

  it('keeps one partition per browser profile', () => {
    const storage = stableStorage(environment({ revision: 10, device: 'a' }))
    expect(bindWslHostBrowserRoutePartition(storage, 'default')).not.toBe(
      bindWslHostBrowserRoutePartition(storage, 'work')
    )
  })

  // Only this identity derives that name, so the page path re-adopts it; the copy must agree.
  it('keeps its own partition after an older build rewrote the binding without its alias', async () => {
    const storage = stableStorage(environment({ revision: 10, device: 'a' }))
    const partition = bindWslHostBrowserRoutePartition(storage, 'default')
    const store = new BrowserRoutePartitionBindingStore({ filePath: bindings.filePath })
    store.remove([partition])
    store.set(partition, 'f'.repeat(64), storage.storageScope)

    expect(bindWslHostBrowserRoutePartition(storage, 'default')).toBe(partition)
    expect(await pagePartition(environment({ revision: 20, device: 'b' }), 'rt-b')).toBe(partition)
  })

  it('reports no stable partition for an environment without a deployment link', () => {
    expect(
      wslHostBrowserRouteStorage(ORCA_PROFILE, environment({ revision: 10, device: 'a' }))
    ).toMatchObject({ kind: 'stable' })
    expect(
      wslHostBrowserRouteStorage(ORCA_PROFILE, environment({ revision: 10, device: 'a' }, null))
    ).toEqual({ kind: 'unavailable', reason: 'no-stable-partition' })
  })

  it('never resolves a managed SSH host, so its partitions stay untouched', () => {
    expect(
      wslHostBrowserRouteStorage(
        ORCA_PROFILE,
        environment({ revision: 10, device: 'a' }, SSH_DEPLOYMENT, 'ssh-managed')
      )
    ).toEqual({ kind: 'unavailable', reason: 'destination-not-wsl-host' })
  })
})
