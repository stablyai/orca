import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'

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

import {
  configurePairedRuntimeBrowserClientHostsForOrcaProfile,
  getPairedRuntimeBrowserClientRouteIdentity,
  startPairedRuntimeBrowserClientHost
} from './paired-runtime-browser-client-host-runtime'

function pairedEnvironment(
  id: string,
  overrides: { pairingRevision?: number; publicKeyB64?: string } = {}
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
    preferredEndpointId: 'endpoint-a',
    endpoints: [
      {
        id: 'endpoint-a',
        endpoint: 'ws://127.0.0.1:9999',
        deviceToken: 'token-a',
        publicKeyB64: overrides.publicKeyB64 ?? 'key-a'
      }
    ]
  } as KnownRuntimeEnvironment
}

/** Authority identity the client host records for `environment` under `authorityRuntimeId`. */
async function connectionIdentity(
  environment: KnownRuntimeEnvironment,
  authorityRuntimeId: string
): Promise<{ current: string; legacy: string }> {
  await startPairedRuntimeBrowserClientHost({ environment, authorityRuntimeId })
  const identity = getPairedRuntimeBrowserClientRouteIdentity(environment.id)
  if (!identity) {
    throw new Error('missing route identity')
  }
  return {
    current: identity.authorityConnectionIdentity,
    legacy: identity.legacyAuthorityConnectionIdentity
  }
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
