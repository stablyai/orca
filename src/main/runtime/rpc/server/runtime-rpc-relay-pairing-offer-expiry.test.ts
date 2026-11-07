import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import '../unused-default-rpc-methods.test-fixture'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeScanCacheModule>()),
  listWorktrees: vi.fn().mockResolvedValue([])
}))

vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeListingModule>()),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

const TTL = 10 * 60_000
const T0 = Date.UTC(2026, 10, 3)

async function startRelayServer(): Promise<{
  server: OrcaRuntimeRpcServer
  revoked: string[]
}> {
  const server = new OrcaRuntimeRpcServer({
    methods: [],
    runtime: new OrcaRuntimeService(),
    userDataPath: mkdtempSync(join(tmpdir(), 'orca-offer-expiry-rpc-')),
    enableWebSocket: true,
    wsPort: 0
  })
  const revoked: string[] = []
  server.setMobileRelayPairingProvider({
    createPairingRelay: async (relayDeviceId) => ({
      relay: {
        v: 1,
        directorUrl: 'https://relay.example.com',
        cellUrl: 'https://cell.example.com',
        assignmentEpoch: 1,
        relayHostId: 'AbCdEf0123_-xyZ9',
        inviteToken: 'A'.repeat(43),
        inviteExpiresAt: Date.now() + TTL,
        e2eeFraming: 2
      },
      binding: { relayHostId: 'AbCdEf0123_-xyZ9', relayDeviceId, ownerIdentityKey: 'owner' }
    }),
    onDeviceRevokeQueued: (item) => revoked.push(item.relayDeviceId),
    getEndpoints: vi.fn(),
    provisionRelay: vi.fn()
  })
  await server.start()
  return { server, revoked }
}

async function mint(server: OrcaRuntimeRpcServer, rotate = false): Promise<string> {
  const offer = await server.createMobilePairingOffer({
    address: '100.64.1.20',
    offerTtlMs: TTL,
    rotate
  })
  if (!offer.available) {
    throw new Error(offer.guidance)
  }
  return offer.deviceId
}

describe('Relay-bound pairing offer expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('revokes the Relay invite of an expired offer when it is discarded', async () => {
    const { server, revoked } = await startRelayServer()
    try {
      const first = await mint(server)
      vi.setSystemTime(T0 + TTL)
      const next = await mint(server)
      expect(next).not.toBe(first)
      expect(revoked).toEqual([first])
      expect(server.getDeviceRegistry()?.getDevice(first)).toBeNull()
    } finally {
      await server.stop()
    }
  })

  it('revokes every overlapping offer on rotate', async () => {
    const { server, revoked } = await startRelayServer()
    try {
      const old = await mint(server)
      vi.setSystemTime(T0 + TTL - 30_000)
      const fresh = await mint(server)
      expect(fresh).not.toBe(old)
      expect(revoked).toEqual([])

      const rotated = await mint(server, true)
      expect(revoked.sort()).toEqual([old, fresh].sort())
      const pending = server.getDeviceRegistry()?.listPendingDevices('mobile')
      expect(pending?.map((d) => d.deviceId)).toEqual([rotated])
    } finally {
      await server.stop()
    }
  })
})
