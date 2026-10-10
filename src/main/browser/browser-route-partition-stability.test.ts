import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type {
  BrowserHostLeaseAuthority,
  BrowserNetworkExecutionHost
} from '../../shared/browser-client-host-protocol'
import { BrowserClientNetworkRouteRegistry } from './browser-client-network-route-registry'
import { browserNetworkExecutionHostKey } from './browser-network-execution-route'
import { deriveBrowserRoutePartition } from './browser-route-identity'
import { BrowserRoutePartitionBindingStore } from './browser-route-partition-binding-store'

const authority: BrowserHostLeaseAuthority = {
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-a',
  browserHostClientId: 'client-a',
  browserHostGeneration: 1
}

const baseIdentity = {
  orcaProfileId: 'orca/profile:alpha',
  browserProfileId: 'browser/profile:default',
  authorityConnectionIdentity: 'paired-runtime:authority-a'
}

function createBindingStorePath(): string {
  return join(
    realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'orca-browser-partition-stability-'))),
    'bindings.json'
  )
}

const storageKeyA = 'a'.repeat(64)
const storageKeyB = 'b'.repeat(64)

function createRegistry(
  host: BrowserNetworkExecutionHost,
  authorityStorageKey: string
): BrowserClientNetworkRouteRegistry {
  return new BrowserClientNetworkRouteRegistry({
    // Why: native/WSL routes are admitted only under their own runtime's authority.
    authority:
      host.kind === 'ssh' ? authority : { ...authority, authorityRuntimeId: host.runtimeId },
    authorityStorageKey,
    createRoute: () => ({
      start: vi.fn(async () => ({ host: '127.0.0.1', port: 43123 })),
      reconnect: vi.fn(async () => ({ host: '127.0.0.1', port: 43123 })),
      suspend: vi.fn(),
      close: vi.fn(async () => {})
    })
  })
}

/** Full client-hosted derivation: route key -> retained route -> partition name. */
async function partitionFor(
  host: BrowserNetworkExecutionHost,
  authorityStorageKey = storageKeyA
): Promise<string> {
  const registry = createRegistry(host, authorityStorageKey)
  const route = await registry.retain(
    browserNetworkExecutionHostKey(host),
    new AbortController().signal
  )
  const derived = deriveBrowserRoutePartition({
    ...baseIdentity,
    executionHostIdentity: route.executionHostIdentity
  })
  await route.release()
  await registry.close()
  return derived.partition
}

async function bindPartition(
  host: BrowserNetworkExecutionHost,
  filePath: string,
  authorityStorageKey = storageKeyA
): Promise<string> {
  const registry = createRegistry(host, authorityStorageKey)
  const route = await registry.retain(
    browserNetworkExecutionHostKey(host),
    new AbortController().signal
  )
  const derived = deriveBrowserRoutePartition({
    ...baseIdentity,
    executionHostIdentity: route.executionHostIdentity
  })
  const store = new BrowserRoutePartitionBindingStore({ filePath })
  if (store.get(derived.partition) === null) {
    store.set(derived.partition, derived.bindingFingerprint, 'e'.repeat(64))
  }
  await route.release()
  await registry.close()
  return derived.partition
}

describe('client-hosted route partition stability', () => {
  it('keeps one partition and one binding across remote runtime restarts', async () => {
    const filePath = createBindingStorePath()
    // Why: the remote mints runtimeId with randomUUID() per process, so a restart moves BOTH
    // runtimeId and revision -- holding runtimeId fixed here would pass without testing anything.
    const before = await bindPartition(
      { kind: 'native', runtimeId: 'runtime-a', revision: 1_700_000_000 },
      filePath
    )
    const after = await bindPartition(
      { kind: 'native', runtimeId: 'runtime-restarted', revision: 1_800_000_000 },
      filePath
    )

    expect(after).toBe(before)
    expect(bindingCount(filePath)).toBe(1)
  })

  it('keeps one partition across SSH reconnect generations and provider epochs', async () => {
    const filePath = createBindingStorePath()
    const before = await bindPartition(
      {
        kind: 'ssh',
        targetId: 'ssh-1700000000-aaa111',
        providerEpoch: 'epoch-1',
        connectionGeneration: 3
      },
      filePath
    )
    // Why: the provider mints a fresh epoch on every generation bump, so both move together.
    const after = await bindPartition(
      {
        kind: 'ssh',
        targetId: 'ssh-1700000000-aaa111',
        providerEpoch: 'epoch-2',
        connectionGeneration: 4
      },
      filePath
    )

    expect(after).toBe(before)
    expect(bindingCount(filePath)).toBe(1)
  })

  it('gives a deleted-and-readded SSH target a fresh partition', async () => {
    const before = await partitionFor({
      kind: 'ssh',
      targetId: 'ssh-1700000000-aaa111',
      providerEpoch: 'epoch-1',
      connectionGeneration: 3
    })
    // Why: SshConnectionStore mints `ssh-<now>-<rand>` per record, so a readd never reuses an id.
    const after = await partitionFor({
      kind: 'ssh',
      targetId: 'ssh-1800000000-bbb222',
      providerEpoch: 'epoch-1',
      connectionGeneration: 3
    })

    expect(after).not.toBe(before)
  })

  it('separates WSL distros and separates WSL from native on one runtime', async () => {
    const ubuntu = await partitionFor({
      kind: 'wsl',
      runtimeId: 'runtime-a',
      revision: 1,
      distro: 'Ubuntu'
    })
    const debian = await partitionFor({
      kind: 'wsl',
      runtimeId: 'runtime-a',
      revision: 1,
      distro: 'Debian'
    })
    const sameDistroRestartedRuntime = await partitionFor({
      kind: 'wsl',
      runtimeId: 'runtime-restarted',
      revision: 99,
      distro: 'Ubuntu'
    })
    const native = await partitionFor({
      kind: 'native',
      runtimeId: 'runtime-a',
      revision: 1
    })

    expect(debian).not.toBe(ubuntu)
    expect(sameDistroRestartedRuntime).toBe(ubuntu)
    expect(native).not.toBe(ubuntu)
  })

  it('separates distinct environment records and never leaks raw host identity', async () => {
    const first = await partitionFor({ kind: 'native', runtimeId: 'runtime-a', revision: 1 })
    const second = await partitionFor(
      { kind: 'native', runtimeId: 'runtime-a', revision: 1 },
      storageKeyB
    )

    expect(second).not.toBe(first)
    expect(first).toMatch(/^persist:orca-browser-v1-[a-f0-9]{64}$/)
    expect(first).not.toContain('runtime-a')
  })
})

function bindingCount(filePath: string): number {
  const store = new BrowserRoutePartitionBindingStore({ filePath })
  return store.listBindings().size
}
