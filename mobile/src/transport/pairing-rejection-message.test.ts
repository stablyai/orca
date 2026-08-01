import { describe, expect, it } from 'vitest'
import { pairingRejectionMessage } from './pairing-rejection-message'

describe('pairingRejectionMessage', () => {
  // Why: the whole point of the version case is telling the user which side is
  // behind — pointing at the wrong machine is worse than saying nothing.
  it('names the phone for a newer offer and the computer for an older one', () => {
    expect(
      pairingRejectionMessage(
        { reason: 'unsupported-version', offerVersion: 3, supportedVersion: 2 },
        'paste'
      )
    ).toContain('Update Orca on your phone')

    expect(
      pairingRejectionMessage(
        { reason: 'unsupported-version', offerVersion: 1, supportedVersion: 2 },
        'paste'
      )
    ).toContain('Update Orca on your computer')
  })

  it('reports both versions either way', () => {
    for (const offerVersion of [1, 3]) {
      const message = pairingRejectionMessage(
        { reason: 'unsupported-version', offerVersion, supportedVersion: 2 },
        'qr'
      )
      expect(message).toContain(`version ${offerVersion}`)
      expect(message).toContain('version 2')
    }
  })

  it('tailors the unreadable-code copy to how the code arrived', () => {
    expect(pairingRejectionMessage({ reason: 'malformed-code' }, 'qr')).toContain('QR code')
    expect(pairingRejectionMessage({ reason: 'malformed-code' }, 'paste')).toContain('paste again')
    expect(pairingRejectionMessage({ reason: 'malformed-code' }, 'deep-link')).toContain(
      'pairing link'
    )
  })
})
