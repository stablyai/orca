import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import '../unused-default-rpc-methods.test-fixture'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const facade = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: facade.listWorktrees
  }
})

vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const facade = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: facade.listWorktreesStrict
  }
})

const { getWorktreeListingMocks } = vi.hoisted(() => {
  const createWorktreeListingMocks = () => ({
    listWorktrees: vi.fn().mockResolvedValue([]),
    listWorktreesStrict: vi.fn().mockResolvedValue([])
  })
  let listings: ReturnType<typeof createWorktreeListingMocks> | undefined
  return { getWorktreeListingMocks: () => (listings ??= createWorktreeListingMocks()) }
})

describe('automatic mobile pairing with a missing Relay provider (#20005)', () => {
  it('installs the provider on demand instead of failing provider_missing', async () => {
    const server = new OrcaRuntimeRpcServer({
      methods: [],
      runtime: new OrcaRuntimeService(),
      userDataPath: mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-')),
      enableWebSocket: true,
      wsPort: 0
    })
    const relay = {
      v: 1 as const,
      directorUrl: 'https://relay.example.com',
      cellUrl: 'https://cell.example.com',
      assignmentEpoch: 7,
      relayHostId: 'AbCdEf0123_-xyZ9',
      inviteToken: 'A'.repeat(43),
      inviteExpiresAt: Date.now() + 60_000,
      e2eeFraming: 2 as const
    }
    const install = vi.fn(async () => {
      server.setMobileRelayPairingProvider({
        createPairingRelay: async (relayDeviceId) => ({
          relay,
          binding: { relayHostId: relay.relayHostId, relayDeviceId, ownerIdentityKey: 'owner' }
        }),
        onDeviceRevokeQueued: vi.fn(),
        getEndpoints: vi.fn(),
        provisionRelay: vi.fn()
      })
    })
    server.setMobileRelayPairingProviderInstaller(install)

    await server.start()
    try {
      const offer = await server.createMobilePairingOffer({ address: '100.64.1.20' })
      expect(install).toHaveBeenCalledOnce()
      expect(offer).toMatchObject({ available: true, connectionMode: 'automatic' })
    } finally {
      await server.stop()
    }
  })

  it('reports the provider missing when an install outlives the mint budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const server = new OrcaRuntimeRpcServer({
      methods: [],
      runtime: new OrcaRuntimeService(),
      userDataPath: mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-')),
      enableWebSocket: true,
      wsPort: 0
    })
    server.setMobileRelayPairingProviderInstaller(() => new Promise(() => {}))
    await server.start()
    try {
      const offer = server.createMobilePairingOffer({ address: '100.64.1.20' })
      await vi.advanceTimersByTimeAsync(15_000)
      await expect(offer).resolves.toMatchObject({
        available: false,
        relayFailure: { stage: 'provider_missing' }
      })
    } finally {
      vi.useRealTimers()
      await server.stop()
    }
  })
})
