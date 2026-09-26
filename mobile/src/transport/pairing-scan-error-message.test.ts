import { describe, expect, it } from 'vitest'
import { getPairingScanErrorMessage } from './pairing-scan-error-message'

describe('getPairingScanErrorMessage', () => {
  it('explains when the scanned QR opens a link instead of a pairing code', () => {
    const message = getPairingScanErrorMessage('HTTPS://orca.example/install')

    expect(message).toContain('opens a link')
    expect(message).toContain('not a desktop pairing code')
    expect(message).toContain('Pairing QR')
  })

  it('points invalid QR payloads to the desktop pairing QR', () => {
    const message = getPairingScanErrorMessage('not-orca')

    expect(message).toContain('not a desktop pairing QR')
    expect(message).toContain('Settings > Mobile')
    expect(message).toContain('Pairing QR')
  })
})
