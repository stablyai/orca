import { describe, expect, it, vi } from 'vitest'
import { PAIRING_TICKET_EXCHANGE_RUNTIME_CAPABILITY } from '../../../src/shared/remote-runtime/pairing/ticket-exchange-capability'
import { exchangePairingTicket } from './pairing-ticket-exchange'
import type { PairingCandidateClient } from './mobile-relay-physical-client'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'

vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(length).fill(171)
}))
const capable = { capabilities: [PAIRING_TICKET_EXCHANGE_RUNTIME_CAPABILITY] }

function client(reply: RpcResponse | Error): PairingCandidateClient & {
  sendRequest: ReturnType<typeof vi.fn>
} {
  return {
    sendRequest: vi.fn(async () => {
      if (reply instanceof Error) {
        throw reply
      }
      return reply
    }),
    close: vi.fn()
  }
}

describe('exchangePairingTicket', () => {
  it('keeps the scanned code on a refusal or a lost reply', async () => {
    const refused: RpcResponse = {
      id: '1',
      ok: false,
      error: { code: 'internal_error', message: 'not_a_ticket' },
      _meta: { runtimeId: 'r' }
    }
    for (const reply of [refused, new Error('socket closed')]) {
      await expect(
        exchangePairingTicket({
          client: client(reply),
          status: capable,
          ticket: 'scanned',
          log: vi.fn()
        })
      ).resolves.toBe('scanned')
    }
  })
})
