import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import { createMobileRelayPairingJournal } from './mobile-relay-pairing-journal'
import {
  recoverMobileRelayPairing,
  resetMobileRelayPairingRecoveryForTests
} from './mobile-relay-pairing-recovery'
import type { PairingCandidateClient } from './mobile-relay-physical-client'
import type { PairingOffer, RpcResponse } from './types'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn() }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED' }))
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }))

const now = Date.UTC(2026, 6, 13)
const offer = {
  v: 2,
  endpoint: 'ws://192.168.1.10:6768',
  deviceToken: 'device-token',
  publicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
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
} satisfies PairingOffer

function response(result: unknown): RpcResponse {
  return { id: 'rpc-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function installed(
  journal: ReturnType<typeof journal>,
  mode: 'authenticated-direct' | 'relay-basis'
) {
  return {
    v: 1 as const,
    reqId: journal.metadata.installReqId,
    authorizationMode: mode,
    currentVersion: 1,
    resumeExpiresAt: now + 86_400_000
  }
}

function endpoints(
  journal: ReturnType<typeof journal>,
  state: { state: 'not-found' } | { state: 'committed'; result: ReturnType<typeof installed> }
) {
  return {
    v: 1 as const,
    relay: {
      v: 1 as const,
      directorUrl: offer.relay.directorUrl,
      cellUrl: offer.relay.cellUrl,
      assignmentEpoch: offer.relay.assignmentEpoch,
      relayHostId: offer.relay.relayHostId,
      e2eeFraming: 2 as const
    },
    installStatus: { v: 1 as const, reqId: journal.metadata.installReqId, ...state }
  }
}

function journal(mode: 'authenticated-direct' | 'relay-basis' = 'authenticated-direct') {
  const value = createMobileRelayPairingJournal({
    offer: offer as PairingOffer & { relay: NonNullable<PairingOffer['relay']> },
    hostId: 'host-1',
    hostName: 'Blue Whale',
    now,
    randomBytes: (length) => new Uint8Array(length).fill(length)
  })
  return {
    ...value,
    metadata: {
      ...value.metadata,
      winner: mode === 'authenticated-direct' ? ('direct' as const) : ('relay' as const),
      authorizationMode: mode
    }
  }
}

function client(handler: (method: string, params: unknown) => Promise<RpcResponse>) {
  return { sendRequest: vi.fn(handler), close: vi.fn() } satisfies PairingCandidateClient
}

function dependencies(args: {
  journal: ReturnType<typeof journal>
  connectRelay: ReturnType<typeof vi.fn>
  bundle?: MobileRelayCredentialBundle | null
}) {
  return {
    loadJournal: vi.fn(async () => args.journal),
    updateJournal: vi.fn(async (_id, update) => {
      Object.assign(args.journal.metadata, update(args.journal.metadata))
    }),
    clearJournal: vi.fn(async () => {}),
    readCredentialBundle: vi.fn(async () => args.bundle ?? null),
    writeCredentialBundle: vi.fn(async () => {}),
    loadHosts: vi.fn(async () => []),
    saveHost: vi.fn(async () => {}),
    connectRelay: args.connectRelay,
    resolveInviteDirector: vi.fn(async () => {
      throw new Error('director not needed')
    }),
    now: () => now,
    platform: 'ios'
  }
}

describe('mobile relay pairing recovery', () => {
  beforeEach(() => {
    resetMobileRelayPairingRecoveryForTests()
  })

  it('recovers a lost direct-install response with the pending credential first', async () => {
    const saved = journal()
    const committed = installed(saved, 'authenticated-direct')
    const pending = client(async (method, params) => {
      expect(method).toBe('pairing.getEndpoints')
      expect(params).toEqual({
        installReqId: saved.metadata.installReqId,
        resumeConfirmReqId: saved.metadata.resumeConfirmReqId
      })
      return response(endpoints(saved, { state: 'committed', result: committed }))
    })
    const connectRelay = vi.fn(() => pending)
    const deps = dependencies({ journal: saved, connectRelay })

    await expect(recoverMobileRelayPairing(deps)).resolves.toBe('recovered')
    expect(connectRelay).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: saved.secrets.pendingResumeToken,
        expectedCredentialKind: 'resume'
      })
    )
    expect(deps.writeCredentialBundle).toHaveBeenCalledOnce()
    expect(deps.saveHost).toHaveBeenCalledOnce()
    expect(deps.clearJournal).toHaveBeenCalledOnce()
  })

  it('tries pending then current before an unexpired invite and transitions after not-found', async () => {
    const saved = journal()
    const currentToken = 'C'.repeat(43)
    const bundle: MobileRelayCredentialBundle = {
      v: 1,
      hostId: 'host-1',
      deviceToken: offer.deviceToken,
      current: {
        token: currentToken,
        hash: 'D'.repeat(43),
        version: 1,
        expiresAt: now + 60_000
      }
    }
    const failed = () =>
      client(async () => {
        throw new Error('resume rejected')
      })
    const relayInstalled = installed(saved, 'relay-basis')
    let statusCalls = 0
    const invite = client(async (method) => {
      if (method === 'pairing.getEndpoints') {
        statusCalls += 1
        return response(
          statusCalls === 1
            ? endpoints(saved, { state: 'not-found' })
            : endpoints(saved, { state: 'committed', result: relayInstalled })
        )
      }
      expect(saved.metadata.authorizationMode).toBe('relay-basis')
      return response(relayInstalled)
    })
    const seenCredentials: (string | undefined)[] = []
    const connectRelay = vi.fn((args) => {
      seenCredentials.push(args.credential)
      return args.credential ? failed() : invite
    })
    const deps = dependencies({ journal: saved, connectRelay, bundle })

    await expect(recoverMobileRelayPairing(deps)).resolves.toBe('recovered')
    expect(seenCredentials).toEqual([saved.secrets.pendingResumeToken, currentToken, undefined])
    expect(deps.updateJournal).toHaveBeenCalledWith(saved.metadata.journalId, expect.any(Function))
    expect(invite.sendRequest).toHaveBeenCalledWith('pairing.provisionRelay', {
      reqId: saved.metadata.installReqId,
      newResumeTokenHash: saved.metadata.pendingResumeTokenHash
    })
  })

  it('accepts the one late direct result after invite fallback observed not-found', async () => {
    const saved = journal()
    const directInstalled = installed(saved, 'authenticated-direct')
    const failedPending = client(async () => {
      throw new Error('pending unavailable')
    })
    let statusCalls = 0
    const invite = client(async (method) => {
      if (method === 'pairing.getEndpoints') {
        statusCalls += 1
        return response(
          statusCalls === 1
            ? endpoints(saved, { state: 'not-found' })
            : endpoints(saved, { state: 'committed', result: directInstalled })
        )
      }
      return response(directInstalled)
    })
    const deps = dependencies({
      journal: saved,
      connectRelay: vi.fn((args) => (args.credential ? failedPending : invite))
    })

    await expect(recoverMobileRelayPairing(deps)).resolves.toBe('recovered')
    const written = deps.writeCredentialBundle.mock.calls[0]![0]
    expect(written.current.token).toBe(saved.secrets.pendingResumeToken)
    expect(saved.metadata.authorizationMode).toBe('authenticated-direct')
    expect(deps.updateJournal).toHaveBeenCalledTimes(2)
  })
})
