import { describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/remote-runtime/pairing/pairing'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime/remote-runtime-client-error'
import { exchangeCliPairingCode } from './environment-pairing-exchange'

const pairingCode = encodePairingOffer({
  v: 2,
  endpoint: 'ws://192.168.1.10:6768',
  deviceToken: 'link-token',
  publicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
})

describe('exchangeCliPairingCode', () => {
  it('refuses to save a code the host rejects, such as one another device already used', async () => {
    for (const send of [
      vi
        .fn()
        .mockRejectedValue(
          new RemoteRuntimeClientError('unauthorized', 'rejected', { pairingStage: 'access-grant' })
        ),
      vi.fn().mockResolvedValue({ ok: false, error: { code: 'unauthorized', message: 'no' } })
    ]) {
      await expect(exchangeCliPairingCode(pairingCode, send)).rejects.toMatchObject({
        code: 'unauthorized'
      })
    }
  })
})
