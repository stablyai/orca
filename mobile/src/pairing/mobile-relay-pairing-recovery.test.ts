import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileRelayCredentialBundle } from '../host-credentials/mobile-relay-credential-bundle'
import { createMobileRelayPairingJournal } from './mobile-relay-pairing-journal'
import {
  recoverMobileRelayPairing,
  resetMobileRelayPairingRecoveryForTests
} from './mobile-relay-pairing-recovery'
import { RelayOuterError } from '../transport/encryption/mobile-relay-e2ee-link'
import type {
  connectMobileRelayForPairing,
  PairingCandidateClient
} from './mobile-relay-physical-client'
import type { HostProfile } from '../host-catalog/host-profile'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'
import type { PairingOffer } from '../../../src/shared/remote-runtime/pairing/mobile-relay-pairing-offer'

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

type TestJournal = ReturnType<typeof journal>

function installed(journal: TestJournal, mode: 'authenticated-direct' | 'relay-basis') {
  return {
    v: 1 as const,
    reqId: journal.metadata.installReqId,
    authorizationMode: mode,
    currentVersion: 1,
    resumeExpiresAt: now + 86_400_000
  }
}

function endpoints(
  journal: TestJournal,
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
    offer,
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
  journal: TestJournal
  connectRelay: typeof connectMobileRelayForPairing
  bundle?: MobileRelayCredentialBundle | null
  hosts?: HostProfile[]
}) {
  const releaseJournal = vi.fn()
  return {
    releaseJournal,
    loadJournal: vi.fn(async () => args.journal),
    updateJournal: vi.fn(async (_id, update) => {
      Object.assign(args.journal.metadata, update(args.journal.metadata))
    }),
    clearJournal: vi.fn(async () => {}),
    claimJournal: vi.fn(async () => releaseJournal),
    readCredentialBundle: vi.fn(async () => args.bundle ?? null),
    writeCredentialBundle: vi.fn(async (_bundle: MobileRelayCredentialBundle) => {}),
    loadHosts: vi.fn(async (): Promise<HostProfile[]> => args.hosts ?? []),
    savePairedHost: vi.fn(async () => {}),
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

  it('abandons a journal once its invite expired and no credential can reconcile', async () => {
    const saved = journal()
    const unreachable = client(async () => {
      throw new Error('relay unreachable')
    })
    const deps = {
      ...dependencies({ journal: saved, connectRelay: vi.fn(() => unreachable) }),
      now: () => saved.metadata.relay.inviteExpiresAt + 10 * 60 * 1000 + 1
    }

    await expect(recoverMobileRelayPairing(deps)).resolves.toBe('abandoned')
    expect(deps.clearJournal).toHaveBeenCalledWith(saved.metadata.journalId)
  })

  it('abandons at once when the relay rejects every credential', async () => {
    const saved = journal()
    const rejected = client(async () => {
      throw new RelayOuterError(4401, true)
    })
    const deps = dependencies({ journal: saved, connectRelay: vi.fn(() => rejected) })

    await expect(recoverMobileRelayPairing(deps)).resolves.toBe('abandoned')
    expect(deps.clearJournal).toHaveBeenCalledWith(saved.metadata.journalId)
  })

  // A bare 4401 can mean first-frame timeout and is not authoritative credential rejection.
  it('keeps a journal whose 4401 closes carried no relay-hello refusal', async () => {
    const saved = journal()
    const timedOut = client(async () => {
      throw new RelayOuterError(4401)
    })
    const deps = dependencies({ journal: saved, connectRelay: vi.fn(() => timedOut) })

    await expect(recoverMobileRelayPairing(deps)).resolves.toBe('deferred')
    expect(deps.clearJournal).not.toHaveBeenCalled()
  })

  it('defers while any credential failed for a transport reason', async () => {
    const saved = journal()
    let calls = 0
    const mixed = client(async () => {
      throw calls++ === 0 ? new RelayOuterError(4401, true) : new RelayOuterError(1006)
    })
    const deps = dependencies({ journal: saved, connectRelay: vi.fn(() => mixed) })

    await expect(recoverMobileRelayPairing(deps)).resolves.toBe('deferred')
    expect(deps.clearJournal).not.toHaveBeenCalled()
  })

  it('keeps a just-expired journal so a brief outage cannot discard it', async () => {
    const saved = journal()
    const unreachable = client(async () => {
      throw new Error('relay unreachable')
    })
    const deps = {
      ...dependencies({ journal: saved, connectRelay: vi.fn(() => unreachable) }),
      now: () => saved.metadata.relay.inviteExpiresAt + 1
    }

    await expect(recoverMobileRelayPairing(deps)).resolves.toBe('deferred')
    expect(deps.clearJournal).not.toHaveBeenCalled()
  })

  // Keep the only retry record when the install committed but local persistence failed.
  it('keeps a journal when the server committed but the local write failed', async () => {
    const saved = journal()
    const directInstalled = installed(saved, 'authenticated-direct')
    const committed = client(async () =>
      response(endpoints(saved, { state: 'committed', result: directInstalled }))
    )
    const deps = {
      ...dependencies({ journal: saved, connectRelay: vi.fn(() => committed) }),
      now: () => saved.metadata.relay.inviteExpiresAt + 10 * 60 * 1000 + 1,
      writeCredentialBundle: vi.fn(async () => {
        throw new Error('keychain unavailable')
      })
    }

    await expect(recoverMobileRelayPairing(deps)).resolves.toBe('deferred')
    expect(deps.clearJournal).not.toHaveBeenCalled()
    expect(deps.writeCredentialBundle).toHaveBeenCalled()
    expect(deps.savePairedHost).not.toHaveBeenCalled()
    expect(deps.releaseJournal).toHaveBeenCalled()
    expect(committed.close).toHaveBeenCalled()
  })
})
