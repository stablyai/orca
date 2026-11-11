import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  KnownRuntimeEnvironment,
  OrcadDeploymentLink
} from '../../../../shared/remote-runtime/host-catalog/runtime-environments'

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

import { deriveBrowserRoutePartition } from '../../routing/partitions/browser-route-identity'
import { BrowserRoutePartitionBindingStore } from '../../routing/partitions/browser-route-partition-binding-store'
import { resolveBrowserRoutePartitionBinding } from '../../routing/partitions/browser-route-partition-migration'
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

/** Models the pre-alias format: pairing identity and fingerprint only. */
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

function bindingStorePath(): string {
  return join(
    realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'orca-re-pair-partition-'))),
    'bindings.json'
  )
}

beforeEach(() => {
  compositions.length = 0
})

describe('client host identity for a server Orca re-pairs in place', () => {
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
