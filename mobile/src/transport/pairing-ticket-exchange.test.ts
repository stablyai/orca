import { describe, expect, it, vi } from 'vitest'
import { PAIRING_TICKET_EXCHANGE_RUNTIME_CAPABILITY } from '../../../src/shared/remote-runtime/pairing/ticket-exchange-capability'
import { exchangePairingTicket } from './pairing-ticket-exchange'
import type { PairingCandidateClient } from './mobile-relay-physical-client'
import type { RpcResponse } from './types'

vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(length).fill(171)
}))

const EXCHANGED = 'ab'.repeat(24)
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

const ok: RpcResponse = {
  id: '1',
  ok: true,
  result: { deviceId: 'phone' },
  _meta: { runtimeId: 'r' }
}

describe('exchangePairingTicket', () => {
  it('sends a token generated on the phone and returns it', async () => {
    const socket = client(ok)
    await expect(
      exchangePairingTicket({ client: socket, status: capable, ticket: 'scanned', log: vi.fn() })
    ).resolves.toBe(EXCHANGED)
    expect(socket.sendRequest).toHaveBeenCalledWith('pairing.exchangeTicket', {
      deviceToken: EXCHANGED
    })
  })

  it('never calls a desktop that does not advertise the exchange', async () => {
    const socket = client(ok)
    await expect(
      exchangePairingTicket({ client: socket, status: {}, ticket: 'scanned', log: vi.fn() })
    ).resolves.toBe('scanned')
    await expect(
      exchangePairingTicket({ client: socket, status: null, ticket: 'scanned', log: vi.fn() })
    ).resolves.toBe('scanned')
    expect(socket.sendRequest).not.toHaveBeenCalled()
  })

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
