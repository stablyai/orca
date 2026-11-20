import { describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../../shared/remote-runtime/pairing/pairing'
import { exchangeCliPairingCode } from './environment-pairing-exchange'

describe('CLI pairing code exchange', () => {
  it("refuses a phone's pairing code before contacting the host", async () => {
    const send = vi.fn()
    const code = encodePairingOffer({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'device-token',
      publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64'),
      scope: 'mobile'
    })
    await expect(exchangeCliPairingCode(code, send)).rejects.toThrow(/mobile-only access/)
    expect(send).not.toHaveBeenCalled()
  })
})
