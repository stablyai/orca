import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { parsePairingCode } from '../../shared/pairing'

vi.mock('../git/worktree', () => {
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
})

describe('OrcaRuntimeRpcServer', () => {
  it('adds only the exact optional relay object to GUI mobile pairing offers', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
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
    server.setMobileRelayPairingProvider({
      createPairingRelay: async (relayDeviceId) => ({
        relay,
        binding: {
          relayHostId: relay.relayHostId,
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
      const offer = await server.createMobilePairingOffer({
        address: '100.64.1.20',
        name: 'Mobile test'
      })
      expect(offer.available).toBe(true)
      if (!offer.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      const parsed = parsePairingCode(offer.pairingUrl)
      expect(parsed).toEqual(
        expect.objectContaining({ endpoint: offer.endpoint, scope: 'mobile', relay })
      )
      expect(parsed).not.toHaveProperty('endpoints')
      expect(offer.connectionMode).toBe('automatic')
      expect(server.getDeviceRegistry()?.getDevice(offer.deviceId)?.relayBinding).toEqual({
        relayHostId: relay.relayHostId,
        relayDeviceId: offer.deviceId,
        ownerIdentityKey: 'user\0profile\0org'
      })
    } finally {
      await server.stop()
    }
  })

  it('queues the old Relay binding when a stable provider changes accounts', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    let relayHostId = 'AbCdEf0123_-xyZ9'
    let ownerIdentityKey = 'user-a\0profile-a\0org'
    const onDeviceRevokeQueued = vi.fn()
    server.setMobileRelayPairingProvider({
      createPairingRelay: async (relayDeviceId) => ({
        relay: {
          v: 1,
          directorUrl: 'https://relay.example.com',
          cellUrl: 'https://cell.example.com',
          assignmentEpoch: 7,
          relayHostId,
          inviteToken: 'A'.repeat(43),
          inviteExpiresAt: Date.now() + 60_000,
          e2eeFraming: 2
        },
        binding: {
          relayHostId,
          relayDeviceId,
          ownerIdentityKey
        }
      }),
      onDeviceRevokeQueued,
      getEndpoints: vi.fn(),
      provisionRelay: vi.fn()
    })

    await server.start()
    try {
      const first = await server.createMobilePairingOffer({ address: '100.64.1.20' })
      expect(first.available).toBe(true)
      if (!first.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      const firstBinding = server.getDeviceRegistry()?.getDevice(first.deviceId)?.relayBinding
      expect(firstBinding).toBeTruthy()
      if (!firstBinding) {
        throw new Error('Relay binding unavailable')
      }
      relayHostId = 'ZyXwVu9876_-abcD'
      ownerIdentityKey = 'user-b\0profile-b\0org'

      const second = await server.createMobilePairingOffer({ address: '100.64.1.20' })
      expect(second.available).toBe(true)
      if (!second.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      expect(second.deviceId).toBe(first.deviceId)
      expect(onDeviceRevokeQueued).toHaveBeenCalledOnce()
      expect(onDeviceRevokeQueued).toHaveBeenCalledWith(expect.objectContaining(firstBinding))
      expect(server.getDeviceRegistry()?.getDevice(second.deviceId)?.relayBinding).toEqual({
        relayHostId,
        relayDeviceId: second.deviceId,
        ownerIdentityKey
      })
    } finally {
      await server.stop()
    }
  })

  it('refuses a silent LAN QR when relay invite minting fails under Anywhere', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    server.setMobileRelayPairingProvider({
      createPairingRelay: vi.fn().mockRejectedValue(new Error('relay offline')),
      onDeviceRevokeQueued: vi.fn(),
      getEndpoints: vi.fn(),
      provisionRelay: vi.fn()
    })

    await server.start()
    try {
      const offer = await server.createMobilePairingOffer({ address: '100.64.1.20' })
      // Why: Anywhere must not ship a scannable local-only code under the Relay label.
      expect(offer.available).toBe(false)
      if (offer.available) {
        throw new Error('expected relay mint failure')
      }
      expect(offer.reason).toBe('relay_mint_failed')
      expect(offer.relayFailure).toMatchObject({
        code: 'relay_mint_failed',
        stage: 'create_pairing_relay'
      })
      expect(server.getDeviceRegistry()?.getPendingDevice('mobile')).toBeNull()
    } finally {
      await server.stop()
    }
  })

  it('reports a missing Relay provider without creating a fallback QR', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()
    try {
      const offer = await server.createMobilePairingOffer({ address: '100.64.1.20' })
      expect(offer).toMatchObject({
        available: false,
        reason: 'relay_mint_failed',
        relayFailure: {
          code: 'relay_provider_unavailable',
          stage: 'provider_missing',
          message: 'Orca Relay is not available on this desktop'
        }
      })
      expect(server.getDeviceRegistry()?.getPendingDevice('mobile')).toBeNull()
    } finally {
      await server.stop()
    }
  })

  it('preserves an existing Relay QR when a same-mode remint fails', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    const createPairingRelay = vi
      .fn()
      .mockImplementationOnce(async (relayDeviceId: string) => ({
        relay: {
          v: 1 as const,
          directorUrl: 'https://relay.example.com',
          cellUrl: 'https://cell.example.com',
          assignmentEpoch: 7,
          relayHostId: 'AbCdEf0123_-xyZ9',
          inviteToken: 'A'.repeat(43),
          inviteExpiresAt: Date.now() + 60_000,
          e2eeFraming: 2 as const
        },
        binding: {
          relayHostId: 'AbCdEf0123_-xyZ9',
          relayDeviceId,
          ownerIdentityKey: 'user\0profile\0org'
        }
      }))
      .mockRejectedValueOnce(new Error('relay offline'))
    server.setMobileRelayPairingProvider({
      createPairingRelay,
      onDeviceRevokeQueued: vi.fn(),
      getEndpoints: vi.fn(),
      provisionRelay: vi.fn()
    })

    await server.start()
    try {
      const first = await server.createMobilePairingOffer({ address: '100.64.1.20' })
      expect(first.available).toBe(true)
      if (!first.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      const second = await server.createMobilePairingOffer({ address: '100.64.1.20' })
      expect(second.available).toBe(false)
      expect(server.getDeviceRegistry()?.getDevice(first.deviceId)?.relayBinding).toBeTruthy()
      expect(server.getDeviceRegistry()?.getPendingDevice('mobile')?.deviceId).toBe(first.deviceId)
    } finally {
      await server.stop()
    }
  })

  it('coalesces concurrent mobile Relay mints for the shared pending credential', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    let resolveFirst: (() => void) | undefined
    const firstMint = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })
    const createPairingRelay = vi.fn(async (relayDeviceId: string) => {
      await firstMint
      return {
        relay: {
          v: 1 as const,
          directorUrl: 'https://relay.example.com',
          cellUrl: 'https://cell.example.com',
          assignmentEpoch: 7,
          relayHostId: 'AbCdEf0123_-xyZ9',
          inviteToken: 'A'.repeat(43),
          inviteExpiresAt: Date.now() + 60_000,
          e2eeFraming: 2 as const
        },
        binding: {
          relayHostId: 'AbCdEf0123_-xyZ9',
          relayDeviceId,
          ownerIdentityKey: 'user\0profile\0org'
        }
      }
    })
    server.setMobileRelayPairingProvider({
      createPairingRelay,
      onDeviceRevokeQueued: vi.fn(),
      getEndpoints: vi.fn(),
      provisionRelay: vi.fn()
    })

    await server.start()
    try {
      const first = server.createMobilePairingOffer({ address: '100.64.1.20', rotate: true })
      const second = server.createMobilePairingOffer({ address: '100.64.1.20', rotate: true })
      await vi.waitFor(() => expect(createPairingRelay).toHaveBeenCalledTimes(1))
      resolveFirst?.()
      const [firstOffer, secondOffer] = await Promise.all([first, second])
      expect(firstOffer.available).toBe(true)
      expect(secondOffer.available).toBe(true)
      if (!firstOffer.available || !secondOffer.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      expect(secondOffer.deviceId).toBe(firstOffer.deviceId)
      expect(secondOffer.pairingUrl).toBe(firstOffer.pairingUrl)
      expect(createPairingRelay).toHaveBeenCalledTimes(1)
    } finally {
      await server.stop()
    }
  })

  it('supersedes an older concurrent Relay rotation for a different address', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    let resolveFirst: (() => void) | undefined
    const firstMint = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })
    const createPairingRelay = vi.fn(async (relayDeviceId: string) => {
      if (createPairingRelay.mock.calls.length === 1) {
        await firstMint
      }
      return {
        relay: {
          v: 1 as const,
          directorUrl: 'https://relay.example.com',
          cellUrl: 'https://cell.example.com',
          assignmentEpoch: 7,
          relayHostId: 'AbCdEf0123_-xyZ9',
          inviteToken: 'A'.repeat(43),
          inviteExpiresAt: Date.now() + 60_000,
          e2eeFraming: 2 as const
        },
        binding: {
          relayHostId: 'AbCdEf0123_-xyZ9',
          relayDeviceId,
          ownerIdentityKey: 'user\0profile\0org'
        }
      }
    })
    const onDeviceRevokeQueued = vi.fn()
    server.setMobileRelayPairingProvider({
      createPairingRelay,
      onDeviceRevokeQueued,
      getEndpoints: vi.fn(),
      provisionRelay: vi.fn()
    })

    await server.start()
    try {
      const first = server.createMobilePairingOffer({
        address: '100.64.1.20',
        rotate: true
      })
      await vi.waitFor(() => expect(createPairingRelay).toHaveBeenCalledOnce())
      const second = server.createMobilePairingOffer({
        address: '100.64.1.21',
        rotate: true
      })
      resolveFirst?.()
      await expect(first).resolves.toMatchObject({
        available: false,
        relayFailure: { code: 'relay_request_superseded' }
      })
      const secondOffer = await second
      expect(secondOffer.available).toBe(true)
      if (!secondOffer.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      expect(secondOffer.endpoint).toContain('100.64.1.21')
      expect(createPairingRelay).toHaveBeenCalledTimes(2)
      expect(onDeviceRevokeQueued).toHaveBeenCalledOnce()
    } finally {
      await server.stop()
    }
  })

  it('supersedes an older concurrent Relay mint for a different address without rotate', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    let resolveFirst: (() => void) | undefined
    const firstMint = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })
    const createPairingRelay = vi.fn(async (relayDeviceId: string) => {
      if (createPairingRelay.mock.calls.length === 1) {
        await firstMint
      }
      return {
        relay: {
          v: 1 as const,
          directorUrl: 'https://relay.example.com',
          cellUrl: 'https://cell.example.com',
          assignmentEpoch: 7,
          relayHostId: 'AbCdEf0123_-xyZ9',
          inviteToken: 'A'.repeat(43),
          inviteExpiresAt: Date.now() + 60_000,
          e2eeFraming: 2 as const
        },
        binding: {
          relayHostId: 'AbCdEf0123_-xyZ9',
          relayDeviceId,
          ownerIdentityKey: 'user\0profile\0org'
        }
      }
    })
    const onDeviceRevokeQueued = vi.fn()
    server.setMobileRelayPairingProvider({
      createPairingRelay,
      onDeviceRevokeQueued,
      getEndpoints: vi.fn(),
      provisionRelay: vi.fn()
    })

    await server.start()
    try {
      const first = server.createMobilePairingOffer({ address: '100.64.1.20' })
      await vi.waitFor(() => expect(createPairingRelay).toHaveBeenCalledOnce())
      const second = server.createMobilePairingOffer({ address: '100.64.1.21' })
      resolveFirst?.()
      await expect(first).resolves.toMatchObject({
        available: false,
        relayFailure: { code: 'relay_request_superseded' }
      })
      const secondOffer = await second
      expect(secondOffer.available).toBe(true)
      if (!secondOffer.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      expect(secondOffer.endpoint).toContain('100.64.1.21')
      expect(onDeviceRevokeQueued).toHaveBeenCalledOnce()
    } finally {
      await server.stop()
    }
  })

  it('lets LAN supersede a pending Relay mint without waiting for it', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    let resolveRelay: (() => void) | undefined
    const relayGate = new Promise<void>((resolve) => {
      resolveRelay = resolve
    })
    const onDeviceRevokeQueued = vi.fn()
    server.setMobileRelayPairingProvider({
      createPairingRelay: async (relayDeviceId) => {
        await relayGate
        return {
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
        }
      },
      onDeviceRevokeQueued,
      getEndpoints: vi.fn(),
      provisionRelay: vi.fn()
    })

    await server.start()
    try {
      const relayOffer = server.createMobilePairingOffer({ address: '100.64.1.20' })
      await vi.waitFor(() =>
        expect(server.getDeviceRegistry()?.getPendingDevice('mobile')).not.toBeNull()
      )
      const localOffer = await server.createMobilePairingOffer({
        address: '100.64.1.20',
        connectionMode: 'local-only'
      })
      expect(localOffer.available).toBe(true)
      if (!localOffer.available) {
        throw new Error('LAN pairing unavailable')
      }
      expect(localOffer.connectionMode).toBe('local-only')
      resolveRelay?.()
      const staleRelayOffer = await relayOffer
      expect(staleRelayOffer.available).toBe(false)
      expect(server.getDeviceRegistry()?.getPendingDevice('mobile')?.deviceId).toBe(
        localOffer.deviceId
      )
      expect(onDeviceRevokeQueued).toHaveBeenCalledOnce()
    } finally {
      await server.stop()
    }
  })

  it('revokes a Relay invite when binding persistence throws', async () => {
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
      const registry = server.getDeviceRegistry()
      if (!registry) {
        throw new Error('Device registry unavailable')
      }
      vi.spyOn(registry, 'setRelayBinding').mockImplementation(() => {
        throw new Error('disk full')
      })
      const offer = await server.createMobilePairingOffer({ address: '100.64.1.20' })
      expect(offer.available).toBe(false)
      expect(onDeviceRevokeQueued).toHaveBeenCalledOnce()
      expect(registry.getPendingDevice('mobile')).toBeNull()
    } finally {
      await server.stop()
    }
  })

  it('revokes a Relay result from a provider replaced during minting', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    let resolveRelay: (() => void) | undefined
    const relayGate = new Promise<void>((resolve) => {
      resolveRelay = resolve
    })
    server.setMobileRelayPairingProvider({
      createPairingRelay: async (relayDeviceId) => {
        await relayGate
        return {
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
        }
      },
      onDeviceRevokeQueued: vi.fn(),
      getEndpoints: vi.fn(),
      provisionRelay: vi.fn()
    })

    await server.start()
    try {
      const offerPromise = server.createMobilePairingOffer({ address: '100.64.1.20' })
      await vi.waitFor(() =>
        expect(server.getDeviceRegistry()?.getPendingDevice('mobile')).not.toBeNull()
      )
      const onDeviceRevokeQueued = vi.fn()
      server.setMobileRelayPairingProvider({
        createPairingRelay: vi.fn(),
        onDeviceRevokeQueued,
        getEndpoints: vi.fn(),
        provisionRelay: vi.fn()
      })
      resolveRelay?.()
      await expect(offerPromise).resolves.toMatchObject({ available: false })
      expect(onDeviceRevokeQueued).toHaveBeenCalledOnce()
      expect(server.getDeviceRegistry()?.getPendingDevice('mobile')).toBeNull()
    } finally {
      await server.stop()
    }
  })

  it('retains a minted Relay binding on the device when cleanup cannot be queued', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    let resolveRelay: (() => void) | undefined
    const relayGate = new Promise<void>((resolve) => {
      resolveRelay = resolve
    })
    server.setMobileRelayPairingProvider({
      createPairingRelay: async (relayDeviceId) => {
        await relayGate
        return {
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
        }
      },
      onDeviceRevokeQueued: vi.fn(),
      getEndpoints: vi.fn(),
      provisionRelay: vi.fn()
    })

    await server.start()
    try {
      const registry = server.getDeviceRegistry()
      if (!registry) {
        throw new Error('Device registry unavailable')
      }
      const offerPromise = server.createMobilePairingOffer({ address: '100.64.1.20' })
      await vi.waitFor(() => expect(registry.getPendingDevice('mobile')).not.toBeNull())
      const deviceId = registry.getPendingDevice('mobile')?.deviceId
      vi.spyOn(server.getRelayRevokeOutbox(), 'enqueue').mockImplementation(() => {
        throw new Error('disk full')
      })
      // Why: swapping the provider supersedes the in-flight mint.
      server.setMobileRelayPairingProvider({
        createPairingRelay: vi.fn(),
        onDeviceRevokeQueued: vi.fn(),
        getEndpoints: vi.fn(),
        provisionRelay: vi.fn()
      })
      resolveRelay?.()
      await expect(offerPromise).resolves.toMatchObject({ available: false })
      expect(registry.getDevice(deviceId ?? '')?.relayBinding).toMatchObject({
        relayHostId: 'AbCdEf0123_-xyZ9',
        relayDeviceId: deviceId
      })
    } finally {
      await server.stop()
    }
  })

  it('queues cloud cleanup when a minted Relay binding cannot be persisted', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    const onDeviceRevokeQueued = vi.fn()
    server.setMobileRelayPairingProvider({
      createPairingRelay: async () => ({
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
          relayDeviceId: 'wrong-device',
          ownerIdentityKey: 'user\0profile\0org'
        }
      }),
      onDeviceRevokeQueued,
      getEndpoints: vi.fn(),
      provisionRelay: vi.fn()
    })

    await server.start()
    try {
      const offer = await server.createMobilePairingOffer({ address: '100.64.1.20' })
      expect(offer.available).toBe(false)
      expect(onDeviceRevokeQueued).toHaveBeenCalledOnce()
      expect(server.getDeviceRegistry()?.getPendingDevice('mobile')).toBeNull()
    } finally {
      await server.stop()
    }
  })
})
