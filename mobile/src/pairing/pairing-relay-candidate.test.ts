import { describe, expect, it, vi } from 'vitest'
import type { PairingCandidateClient } from './mobile-relay-physical-client'
import { RelayOuterError } from '../transport/encryption/mobile-relay-e2ee-link'
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
})
