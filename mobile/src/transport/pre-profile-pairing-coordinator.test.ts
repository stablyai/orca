import { describe, expect, it, vi } from 'vitest'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import type { MobileRelayPairingJournal } from './mobile-relay-pairing-journal'
import { racePairingCandidates } from './pairing-candidate-race'
import { startPreProfilePairing } from './pre-profile-pairing-coordinator'
import type { HostProfile, PairingOffer, RpcResponse } from './types'
import type { RpcClient } from './rpc-client'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(length).fill(length)
}))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED' }))

const now = Date.UTC(2026, 6, 13)
const directOffer: PairingOffer = {
  v: 2,
  endpoint: 'ws://192.168.1.10:6768',
  deviceToken: 'device-token',
  publicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
}
const relayOffer: PairingOffer = {
  ...directOffer,
  relay: {
    v: 1,
    directorUrl: 'https://relay.onorca.dev',
    cellUrl: 'https://relay-c1.onorca.dev',
    assignmentEpoch: 7,
    relayHostId: 'AbCdEf0123_-xyZ9',
    inviteToken: 'abcdefghijklmnopqrstuvwxyzABCDEFGH012345678',
    inviteExpiresAt: now + 300_000,
    e2eeFraming: 2
  }
}

function success(result: unknown): RpcResponse {
  return { id: 'rpc-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function failure(code: string): RpcResponse {
  return {
    id: 'rpc-1',
    ok: false,
    error: { code, message: code },
    _meta: { runtimeId: 'runtime-1' }
  }
}

function fakeClient(responses: RpcResponse[]) {
  return {
    sendRequest: vi.fn().mockImplementation(async () => responses.shift()!),
    close: vi.fn()
  } as unknown as RpcClient
}

function dependencies(client: RpcClient, events: string[]) {
  const unavailableRelay = fakeClient([])
  ;(unavailableRelay.sendRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
    new Error('relay unavailable')
  )
  return {
    connectDirect: vi.fn(() => (events.push('connect'), client)),
    connectRelay: vi.fn(() => unavailableRelay),
    resolveInviteDirector: vi.fn(async () => {
      throw new Error('director unavailable')
    }),
    getNextHostName: vi.fn(async () => 'Blue Whale'),
    saveHost: vi.fn(async (_host: HostProfile) => {
      events.push('save-host')
    }),
    saveJournal: vi.fn(async (_journal: MobileRelayPairingJournal) => {
      events.push('save-journal')
    }),
    updateJournal: vi.fn(async () => {
      events.push('update-journal')
    }),
    clearJournal: vi.fn(async () => {
      events.push('clear-journal')
    }),
    writeCredentialBundle: vi.fn(async (_bundle: MobileRelayCredentialBundle) => {
      events.push('write-credential')
    }),
    now: () => now,
    platform: 'ios'
  }
}

describe('pre-profile pairing coordinator', () => {
  it('chooses direct when both post-E2EE status successes settle in the same turn', async () => {
    let resolveDirect!: (response: RpcResponse) => void
    let resolveRelay!: (response: RpcResponse) => void
    const direct = fakeClient([])
    const relay = fakeClient([])
    ;(direct.sendRequest as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<RpcResponse>((resolve) => {
        resolveDirect = resolve
      })
    )
    ;(relay.sendRequest as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<RpcResponse>((resolve) => {
        resolveRelay = resolve
      })
    )
    const racing = racePairingCandidates([
      { path: 'direct', client: direct },
      { path: 'relay', client: relay }
    ])
    resolveRelay(success({ path: 'relay' }))
    resolveDirect(success({ path: 'direct' }))

    await expect(racing).resolves.toMatchObject({ path: 'direct' })
    expect(relay.close).toHaveBeenCalledOnce()
    expect(direct.close).not.toHaveBeenCalled()
  })

  it('keeps a legacy offer direct-only through the shared path', async () => {
    const events: string[] = []
    const client = fakeClient([success({ version: '1.0.0' })])
    const deps = dependencies(client, events)

    const attempt = startPreProfilePairing({
      offer: directOffer,
      timeoutMs: 5_000,
      dependencies: deps
    })

    await expect(attempt.result).resolves.toEqual({ hostId: `host-${now}` })
    expect(deps.saveHost).toHaveBeenCalledWith({
      id: `host-${now}`,
      name: 'Blue Whale',
      endpoint: directOffer.endpoint,
      deviceToken: directOffer.deviceToken,
      publicKeyB64: directOffer.publicKeyB64,
      lastConnected: now
    })
    expect(events).toEqual(['connect', 'save-host'])
  })

  it('journals before connecting and publishes only after authoritative direct install', async () => {
    const events: string[] = []
    let journal: MobileRelayPairingJournal | null = null
    const client = {
      sendRequest: vi.fn(async (method: string) => {
        if (method === 'status.get') {
          return success({ version: '1.0.0' })
        }
        if (!journal) {
          throw new Error('journal was not saved before RPC')
        }
        const installed = {
          v: 1 as const,
          reqId: journal.metadata.installReqId,
          authorizationMode: 'authenticated-direct' as const,
          currentVersion: 1,
          resumeExpiresAt: now + 86_400_000
        }
        if (method === 'pairing.provisionRelay') {
          return success(installed)
        }
        return success({
          v: 1,
          relay: {
            v: 1,
            directorUrl: relayOffer.relay!.directorUrl,
            cellUrl: relayOffer.relay!.cellUrl,
            assignmentEpoch: 7,
            relayHostId: relayOffer.relay!.relayHostId,
            e2eeFraming: 2
          },
          installStatus: {
            v: 1,
            reqId: journal.metadata.installReqId,
            state: 'committed',
            result: installed
          }
        })
      }),
      close: vi.fn()
    } as unknown as RpcClient
    const deps = dependencies(client, events)
    deps.saveJournal.mockImplementation(async (value) => {
      journal = value
      events.push('save-journal')
    })

    const attempt = startPreProfilePairing({
      offer: relayOffer,
      timeoutMs: 5_000,
      dependencies: deps
    })
    await expect(attempt.result).resolves.toEqual({ hostId: `host-${now}` })

    expect(journal).not.toBeNull()
    expect(events).toEqual([
      'save-journal',
      'connect',
      'update-journal',
      'write-credential',
      'save-host',
      'clear-journal'
    ])
    expect(client.sendRequest).toHaveBeenNthCalledWith(2, 'pairing.provisionRelay', {
      reqId: journal!.metadata.installReqId,
      newResumeTokenHash: journal!.metadata.pendingResumeTokenHash
    })
    expect(deps.saveHost).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `host-${now}`,
        endpoint: directOffer.endpoint,
        relayHostId: relayOffer.relay!.relayHostId,
        endpoints: [
          { id: 'direct-primary', kind: 'lan', url: directOffer.endpoint },
          {
            id: 'relay-primary',
            kind: 'relay',
            url: `wss://relay-c1.onorca.dev/v1/connect/${relayOffer.relay!.relayHostId}`
          }
        ]
      })
    )
  })

  it('tolerates an old desktop method_not_found and commits a direct-only host', async () => {
    const events: string[] = []
    const client = fakeClient([success({ version: '1.0.0' }), failure('method_not_found')])
    const deps = dependencies(client, events)

    const attempt = startPreProfilePairing({
      offer: relayOffer,
      timeoutMs: 5_000,
      dependencies: deps
    })
    await expect(attempt.result).resolves.toEqual({ hostId: `host-${now}` })

    expect(deps.saveHost).toHaveBeenCalledWith(
      expect.not.objectContaining({ endpoints: expect.anything() })
    )
    expect(events).toEqual([
      'save-journal',
      'connect',
      'update-journal',
      'save-host',
      'clear-journal'
    ])
  })

  it('uses relay-basis provisioning when only the relay reaches post-E2EE status', async () => {
    const direct = fakeClient([])
    ;(direct.sendRequest as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('LAN down'))
    let journal: MobileRelayPairingJournal | null = null
    const relay = {
      sendRequest: vi.fn(async (method: string) => {
        if (method === 'status.get') {
          return success({ path: 'relay' })
        }
        const installed = {
          v: 1 as const,
          reqId: journal!.metadata.installReqId,
          authorizationMode: 'relay-basis' as const,
          currentVersion: 1,
          resumeExpiresAt: now + 86_400_000
        }
        if (method === 'pairing.provisionRelay') {
          return success(installed)
        }
        return success({
          v: 1,
          relay: {
            v: 1,
            directorUrl: relayOffer.relay!.directorUrl,
            cellUrl: relayOffer.relay!.cellUrl,
            assignmentEpoch: 7,
            relayHostId: relayOffer.relay!.relayHostId,
            e2eeFraming: 2
          },
          installStatus: {
            v: 1,
            reqId: journal!.metadata.installReqId,
            state: 'committed',
            result: installed
          }
        })
      }),
      close: vi.fn()
    } as unknown as RpcClient
    const deps = dependencies(direct, [])
    deps.connectRelay.mockReturnValue(relay)
    deps.saveJournal.mockImplementation(async (value) => {
      journal = value
    })

    const attempt = startPreProfilePairing({
      offer: relayOffer,
      timeoutMs: 5_000,
      dependencies: deps
    })
    await expect(attempt.result).resolves.toEqual({ hostId: `host-${now}` })

    expect(direct.close).toHaveBeenCalled()
    expect(relay.sendRequest).toHaveBeenNthCalledWith(2, 'pairing.provisionRelay', {
      reqId: journal!.metadata.installReqId,
      newResumeTokenHash: journal!.metadata.pendingResumeTokenHash
    })
    expect(deps.writeCredentialBundle).toHaveBeenCalledWith(
      expect.objectContaining({ current: expect.objectContaining({ version: 1 }) })
    )
  })

  it('cancels the disposable physical client without publishing a host', async () => {
    let resolveStatus!: (response: RpcResponse) => void
    const status = new Promise<RpcResponse>((resolve) => {
      resolveStatus = resolve
    })
    const client = fakeClient([])
    ;(client.sendRequest as ReturnType<typeof vi.fn>).mockReturnValue(status)
    const deps = dependencies(client, [])
    const attempt = startPreProfilePairing({
      offer: directOffer,
      timeoutMs: 5_000,
      dependencies: deps
    })
    await vi.waitFor(() => expect(client.sendRequest).toHaveBeenCalledWith('status.get'))
    attempt.dispose()
    resolveStatus(success({ version: '1.0.0' }))

    await expect(attempt.result).rejects.toThrow(/cancelled/)
    expect(client.close).toHaveBeenCalledOnce()
    expect(deps.saveHost).not.toHaveBeenCalled()
  })
})
