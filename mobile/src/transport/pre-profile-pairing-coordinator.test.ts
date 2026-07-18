import { describe, expect, it, vi } from 'vitest'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import type { MobileRelayPairingJournal } from './mobile-relay-pairing-journal'
import {
  PairingAuthenticationError,
  selectOrderedPairingCandidate
} from './ordered-pairing-candidate'
import { startPreProfilePairing } from './pre-profile-pairing-coordinator'
import type { HostProfile, PairingOffer, RpcResponse } from './types'
import type { RpcClient } from './rpc-client'
import { MobileE2EEAuthenticationError } from './mobile-e2ee-v2-physical-channel'

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
    resolveHostIdentity: vi.fn(async (_publicKeyB64: string, hostId: string) => ({
      id: hostId,
      name: 'Blue Whale',
      publicationEpoch: 1
    })),
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

describe('ordered pairing candidate selection', () => {
  it('opens routes sequentially and stops after the first authenticated success', async () => {
    const events: string[] = []
    const failed = fakeClient([failure('unavailable')])
    const relay = fakeClient([success({ version: '1.0.0' })])
    const unused = fakeClient([success({ version: '1.0.0' })])

    const winner = await selectOrderedPairingCandidate(
      [
        { path: 'direct', open: () => (events.push('direct-1'), failed) },
        { path: 'relay', open: () => (events.push('relay'), relay) },
        { path: 'direct', open: () => (events.push('direct-2'), unused) }
      ],
      1000
    )

    expect(winner).toMatchObject({ path: 'relay', client: relay })
    expect(events).toEqual(['direct-1', 'relay'])
    expect(failed.close).toHaveBeenCalledOnce()
  })

  it('advances when constructing an unreachable route throws synchronously', async () => {
    const connected = fakeClient([success({ version: '1.0.0' })])

    await expect(
      selectOrderedPairingCandidate(
        [
          {
            path: 'direct',
            open: () => {
              throw new Error('invalid WebSocket URL')
            }
          },
          { path: 'relay', open: () => connected }
        ],
        1000
      )
    ).resolves.toMatchObject({ path: 'relay', client: connected })
  })

  it('does not try another address after the pinned desktop rejects authentication', async () => {
    const rejected = fakeClient([failure('unauthorized')])
    const nextOpen = vi.fn(() => fakeClient([success({})]))

    await expect(
      selectOrderedPairingCandidate(
        [
          { path: 'direct', open: () => rejected },
          { path: 'relay', open: nextOpen }
        ],
        1000
      )
    ).rejects.toBeInstanceOf(PairingAuthenticationError)
    expect(nextOpen).not.toHaveBeenCalled()
  })

  it('does not try a lower-ranked route after Relay E2EE authentication fails', async () => {
    const rejected = fakeClient([])
    ;(rejected.sendRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
      new MobileE2EEAuthenticationError()
    )
    const nextOpen = vi.fn(() => fakeClient([success({})]))

    await expect(
      selectOrderedPairingCandidate(
        [
          { path: 'relay', open: () => rejected },
          { path: 'direct', open: nextOpen }
        ],
        1000
      )
    ).rejects.toBeInstanceOf(PairingAuthenticationError)
    expect(nextOpen).not.toHaveBeenCalled()
  })

  it('does not open another route after the overall pairing attempt is cancelled', async () => {
    let cancelled = false
    const failed = fakeClient([])
    ;(failed.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      cancelled = true
      return failure('unavailable')
    })
    const nextOpen = vi.fn(() => fakeClient([success({})]))

    await expect(
      selectOrderedPairingCandidate(
        [
          { path: 'direct', open: () => failed },
          { path: 'relay', open: nextOpen }
        ],
        1000,
        undefined,
        () => cancelled
      )
    ).rejects.toThrow('pairing attempt cancelled')
    expect(failed.close).toHaveBeenCalledOnce()
    expect(nextOpen).not.toHaveBeenCalled()
  })
})

describe('pre-profile pairing coordinator', () => {
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
    expect(deps.saveHost).toHaveBeenCalledWith(
      {
        id: `host-${now}`,
        name: 'Blue Whale',
        endpoint: directOffer.endpoint,
        endpoints: [{ id: 'direct-primary', kind: 'lan', url: directOffer.endpoint }],
        deviceToken: directOffer.deviceToken,
        publicKeyB64: directOffer.publicKeyB64,
        lastConnected: now,
        lastGoodEndpoint: directOffer.endpoint
      },
      1
    )
    expect(events).toEqual(['connect', 'save-host'])
  })

  it('pairs through the next ordered direct address when the primary fails', async () => {
    const events: string[] = []
    const failed = fakeClient([failure('unavailable')])
    const connected = fakeClient([success({ version: '1.0.0' })])
    const deps = dependencies(connected, events)
    deps.connectDirect = vi.fn((endpoint: string) => {
      events.push(endpoint)
      return endpoint === directOffer.endpoint ? failed : connected
    })
    const secondary = 'ws://100.64.1.20:6768'

    const attempt = startPreProfilePairing({
      offer: {
        ...directOffer,
        endpoints: [directOffer.endpoint, secondary],
        routeOrder: 1
      },
      timeoutMs: 5_000,
      dependencies: deps
    })

    await expect(attempt.result).resolves.toEqual({ hostId: `host-${now}` })
    expect(events).toEqual([directOffer.endpoint, secondary, 'save-host'])
    expect(deps.saveHost).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: directOffer.endpoint,
        endpoints: [
          { id: 'direct-primary', kind: 'lan', url: directOffer.endpoint },
          { id: 'direct-1', kind: 'tailscale', url: secondary }
        ],
        lastGoodEndpoint: secondary
      }),
      1
    )
  })

  it('reuses the existing host id and name when re-pairing the same desktop key (no duplicate)', async () => {
    // STA-1840: re-pairing a desktop already stored under a different id must
    // merge into that card, not mint a new host-${now} and duplicate the row.
    const events: string[] = []
    const client = fakeClient([success({ version: '1.0.0' })])
    const deps = dependencies(client, events)
    deps.resolveHostIdentity = vi.fn(async (publicKeyB64: string, newHostId: string) => {
      expect(publicKeyB64).toBe(directOffer.publicKeyB64)
      expect(newHostId).toBe(`host-${now}`)
      return { id: 'host-existing', name: 'Studio Mac', publicationEpoch: 7 }
    })

    const attempt = startPreProfilePairing({
      offer: directOffer,
      timeoutMs: 5_000,
      dependencies: deps
    })

    await expect(attempt.result).resolves.toEqual({ hostId: 'host-existing' })
    expect(deps.saveHost).toHaveBeenCalledWith(
      {
        id: 'host-existing',
        name: 'Studio Mac',
        endpoint: directOffer.endpoint,
        endpoints: [{ id: 'direct-primary', kind: 'lan', url: directOffer.endpoint }],
        deviceToken: directOffer.deviceToken,
        publicKeyB64: directOffer.publicKeyB64,
        lastConnected: now,
        lastGoodEndpoint: directOffer.endpoint
      },
      7
    )
  })

  it('races both legacy routes and publishes only after authoritative direct install', async () => {
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
    expect(deps.connectDirect).toHaveBeenCalledOnce()
    expect(deps.connectRelay).toHaveBeenCalledOnce()
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
        ],
        lastGoodEndpoint: directOffer.endpoint
      }),
      1
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
      expect.objectContaining({
        endpoint: relayOffer.endpoint,
        endpoints: [{ id: 'direct-primary', kind: 'lan', url: relayOffer.endpoint }]
      }),
      1
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
    expect(deps.saveHost).toHaveBeenCalledWith(
      expect.objectContaining({
        lastGoodEndpoint: `wss://relay-c1.onorca.dev/v1/connect/${relayOffer.relay!.relayHostId}`
      }),
      1
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

  it('rejects at the overall deadline even when host persistence is stalled', async () => {
    vi.useFakeTimers()
    try {
      let finishSave!: () => void
      const client = fakeClient([success({ version: '1.0.0' })])
      const deps = dependencies(client, [])
      deps.saveHost = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishSave = resolve
          })
      )
      const attempt = startPreProfilePairing({
        offer: directOffer,
        timeoutMs: 25,
        dependencies: deps
      })

      for (let i = 0; i < 20 && deps.saveHost.mock.calls.length === 0; i += 1) {
        await Promise.resolve()
      }
      expect(deps.saveHost).toHaveBeenCalledOnce()
      const rejected = expect(attempt.result).rejects.toThrow('mobile pairing timed out')
      await vi.advanceTimersByTimeAsync(25)
      await rejected
      expect(attempt.timedOut).toBe(true)

      finishSave()
      await Promise.resolve()
    } finally {
      vi.useRealTimers()
    }
  })
})
