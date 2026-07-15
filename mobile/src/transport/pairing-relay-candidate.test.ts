import { describe, expect, it, vi } from 'vitest'
import type { PairingCandidateClient } from './mobile-relay-physical-client'
import { RelayOuterError } from './mobile-relay-physical-client'
import { createRecoveringPairingRelayCandidate } from './pairing-relay-candidate'
import type { MobileRelayPairingJournal } from './mobile-relay-pairing-journal'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(length).fill(length)
}))

const journal = {
  metadata: {
    v: 1,
    journalId: 'pair-1',
    offerFingerprint: 'A'.repeat(43),
    host: {
      id: 'host-1',
      name: 'Blue Whale',
      endpoint: 'ws://192.168.1.10:6768',
      publicKeyB64: 'A'.repeat(44),
      lastConnected: 1
    },
    relay: {
      v: 1,
      directorUrl: 'https://relay.onorca.dev',
      cellUrl: 'https://relay-c1.onorca.dev',
      assignmentEpoch: 7,
      relayHostId: 'AbCdEf0123_-xyZ9',
      inviteExpiresAt: 10_000,
      e2eeFraming: 2
    },
    installReqId: 'install-1',
    resumeConfirmReqId: 'confirm-1',
    pendingResumeTokenHash: 'B'.repeat(43)
  },
  secrets: {
    v: 1,
    journalId: 'pair-1',
    deviceToken: 'device-token',
    inviteToken: 'C'.repeat(43),
    pendingResumeToken: 'D'.repeat(43)
  }
} satisfies MobileRelayPairingJournal

function client(
  result: Promise<never> | Promise<ReturnType<typeof success>>
): PairingCandidateClient {
  return { sendRequest: vi.fn(() => result), close: vi.fn() }
}

function success() {
  return {
    id: 'rpc-1',
    ok: true as const,
    result: { path: 'relay' },
    _meta: { runtimeId: 'runtime-1' }
  }
}

describe('recovering pairing relay candidate', () => {
  it('persists a strictly-newer director move before retrying the target', async () => {
    const events: string[] = []
    const stale = client(Promise.reject(new RelayOuterError(4409)))
    const target = client(Promise.resolve(success()))
    let connects = 0
    const candidate = createRecoveringPairingRelayCandidate({
      journal,
      connect: (relay) => {
        events.push(`connect:${relay.assignmentEpoch}`)
        return connects++ === 0 ? stale : target
      },
      resolveDirector: async (relay) => ({
        ...relay,
        cellUrl: 'https://relay-c2.onorca.dev',
        assignmentEpoch: 8
      }),
      persistMove: async (relay) => {
        events.push(`persist:${relay.assignmentEpoch}`)
      },
      now: () => 1,
      random: () => 0,
      sleep: async () => {}
    })

    await expect(candidate.sendRequest('status.get')).resolves.toEqual(success())
    expect(events).toEqual(['connect:7', 'persist:8', 'connect:8'])
    expect(stale.close).toHaveBeenCalledOnce()
  })

  it('does not ask the director to reinterpret endpoint-scoped host-offline', async () => {
    const offline = client(Promise.reject(new RelayOuterError(4404)))
    const resolveDirector = vi.fn()
    const candidate = createRecoveringPairingRelayCandidate({
      journal,
      connect: () => offline,
      resolveDirector,
      persistMove: vi.fn(),
      now: () => 1
    })

    await expect(candidate.sendRequest('status.get')).rejects.toEqual(new RelayOuterError(4404))
    expect(resolveDirector).not.toHaveBeenCalled()
  })

  it.each([
    ['wrong cell', new RelayOuterError(4409)],
    ['planned drain', new RelayOuterError(4503)],
    ['opaque close', new RelayOuterError(1006)],
    ['HTTP 502', new Error('HTTP 502')],
    ['HTTP 503', new Error('HTTP 503')],
    ['HTTP 504', new Error('HTTP 504')],
    ['transport failure', new Error('relay transport error')]
  ])('uses the configured director after %s before E2EE', async (_name, failure) => {
    const stale = client(Promise.reject(failure))
    const target = client(Promise.resolve(success()))
    const resolveDirector = vi.fn(async (relay) => ({
      ...relay,
      cellUrl: 'https://relay-c2.onorca.dev',
      assignmentEpoch: 8
    }))
    let connects = 0
    const candidate = createRecoveringPairingRelayCandidate({
      journal,
      connect: () => (connects++ === 0 ? stale : target),
      resolveDirector,
      persistMove: vi.fn(async () => {}),
      now: () => 1,
      random: () => 0,
      sleep: async () => {}
    })

    await expect(candidate.sendRequest('status.get')).resolves.toEqual(success())
    expect(resolveDirector).toHaveBeenCalledOnce()
  })

  it('bounds director recovery and applies full jitter to failures and target retries', async () => {
    const stale = client(Promise.reject(new Error('HTTP 503')))
    const target = client(Promise.resolve(success()))
    const resolveDirector = vi
      .fn()
      .mockRejectedValueOnce(new Error('HTTP 504'))
      .mockRejectedValueOnce(new RelayOuterError(1006))
      .mockImplementationOnce(async (relay) => ({
        ...relay,
        cellUrl: 'https://relay-c2.onorca.dev',
        assignmentEpoch: 8
      }))
    const sleep = vi.fn(async () => {})
    let connects = 0
    const candidate = createRecoveringPairingRelayCandidate({
      journal,
      connect: () => (connects++ === 0 ? stale : target),
      resolveDirector,
      persistMove: vi.fn(async () => {}),
      now: () => 1,
      random: () => 0.5,
      sleep,
      maxRecoveryAttempts: 3
    })

    await expect(candidate.sendRequest('status.get')).resolves.toEqual(success())
    expect(resolveDirector).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([50, 100, 200])
  })
})
