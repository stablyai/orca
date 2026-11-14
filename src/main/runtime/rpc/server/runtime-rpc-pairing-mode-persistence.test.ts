import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { parsePairingCode } from '../../../../shared/remote-runtime/pairing/pairing'
import './runtime-rpc-mobile-ws-test-harness'

vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const listings = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: listings.listWorktrees
  }
})

vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const listings = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: listings.listWorktreesStrict
  }
})

const { getWorktreeListingMocks } = vi.hoisted(() => {
  function createWorktreeListingMocks() {
    const worktrees = [
      {
        path: '/tmp/worktree-a',
        head: 'abc',
        branch: 'feature/foo',
        isBare: false,
        isMainWorktree: false
      }
    ]
    return {
      listWorktrees: vi.fn().mockResolvedValue(worktrees),
      listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
    }
  }
  let listings: ReturnType<typeof createWorktreeListingMocks> | undefined
  return { getWorktreeListingMocks: () => (listings ??= createWorktreeListingMocks()) }
})

describe('OrcaRuntimeRpcServer', () => {
  it('revokes and rotates a pending Relay code when switching it to local-only', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    const onDeviceRevokeQueued = vi.fn()
    server.setMobileRelayPairingProvider({
      createPairingRelay: async (relayDeviceId) => ({
        relay: {
          v: 1,
          directorUrl: 'https://relay.example.com',
          cellUrl: 'https://cell.example.com',
          assignmentEpoch: 7,
          relayHostId: 'AbCdEf0123_-xyZ9',
          inviteToken: 'A'.repeat(43),
          inviteExpiresAt: Date.now() + 60_000,
          e2eeFraming: 2
        },
        binding: {
          relayHostId: 'AbCdEf0123_-xyZ9',
          relayDeviceId,
          ownerIdentityKey: 'user\0profile\0org'
        }
      }),
      onDeviceRevokeQueued,
      getEndpoints: vi.fn(),
      provisionRelay: vi.fn()
    })

    await server.start()
    try {
      const anywhere = await server.createMobilePairingOffer({ address: '100.64.1.20' })
      expect(anywhere.available).toBe(true)
      if (!anywhere.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      const local = await server.createMobilePairingOffer({
        address: '100.64.1.20',
        connectionMode: 'local-only'
      })
      expect(local.available).toBe(true)
      if (!local.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      expect(local.deviceId).not.toBe(anywhere.deviceId)
      expect(server.getDeviceRegistry()?.getDevice(anywhere.deviceId)).toBeNull()
      expect(onDeviceRevokeQueued).toHaveBeenCalledOnce()
      expect(parsePairingCode(local.pairingUrl)).not.toHaveProperty('relay')
    } finally {
      await server.stop()
    }
  })

  it('rotates a pending local-only code when switching it back to Anywhere', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    server.setMobileRelayPairingProvider({
      createPairingRelay: async (relayDeviceId) => ({
        relay: {
          v: 1,
          directorUrl: 'https://relay.example.com',
          cellUrl: 'https://cell.example.com',
          assignmentEpoch: 7,
          relayHostId: 'AbCdEf0123_-xyZ9',
          inviteToken: 'A'.repeat(43),
          inviteExpiresAt: Date.now() + 60_000,
          e2eeFraming: 2
        },
        binding: {
          relayHostId: 'AbCdEf0123_-xyZ9',
          relayDeviceId,
          ownerIdentityKey: 'user\0profile\0org'
        }
      }),
      onDeviceRevokeQueued: vi.fn(),
      getEndpoints: vi.fn(),
      provisionRelay: vi.fn()
    })

    await server.start()
    try {
      const local = await server.createMobilePairingOffer({
        address: '100.64.1.20',
        connectionMode: 'local-only'
      })
      expect(local.available).toBe(true)
      if (!local.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      const anywhere = await server.createMobilePairingOffer({ address: '100.64.1.20' })
      expect(anywhere.available).toBe(true)
      if (!anywhere.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      // Changing local-only policy must mint a new token; an already-shown QR cannot silently gain anywhere access.
      expect(anywhere.deviceId).not.toBe(local.deviceId)
      expect(server.getDeviceRegistry()?.getDevice(local.deviceId)).toBeNull()
      expect(anywhere.connectionMode).toBe('automatic')
      expect(parsePairingCode(anywhere.pairingUrl)).toHaveProperty('relay')
    } finally {
      await server.stop()
    }
  })
})
