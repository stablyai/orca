import { describe, expect, it, vi } from 'vitest'
import { encodePairingOffer, parsePairingCode } from '../../shared/remote-runtime/pairing/pairing'
import { PAIRING_TICKET_EXCHANGE_RUNTIME_CAPABILITY } from '../../shared/remote-runtime/pairing/ticket-exchange-capability'
import { exchangeCliPairingCode } from './environment-pairing-exchange'

const pairingCode = encodePairingOffer({
  v: 2,
  endpoint: 'ws://192.168.1.10:6768',
  deviceToken: 'link-token',
  publicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
})

describe('exchangeCliPairingCode', () => {
  it('exchanges when the host advertises it', async () => {
    const send = vi.fn(async (_connection: unknown, method: string) =>
      method === 'status.get'
        ? { ok: true, result: { capabilities: [PAIRING_TICKET_EXCHANGE_RUNTIME_CAPABILITY] } }
        : { ok: true, result: { deviceId: 'd' } }
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub answers the two methods this helper sends with their real result shapes.
    const saved = await exchangeCliPairingCode(pairingCode, send as never)
    expect(parsePairingCode(saved)?.deviceToken).toMatch(/^[0-9a-f]{48}$/)
  })

  it('saves the code unchanged when the host is unreachable or the code is invalid', async () => {
    const send = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(exchangeCliPairingCode(pairingCode, send)).resolves.toBe(pairingCode)
    await expect(exchangeCliPairingCode('not a code', send)).resolves.toBe('not a code')
    expect(send).toHaveBeenCalledOnce()
  })
})
