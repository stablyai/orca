import { describe, expect, it } from 'vitest'
import { pairingErrorMessage } from './pairing-error-presentation'

describe('pairingErrorMessage', () => {
  it('turns a retired publication into a recovery instruction', () => {
    expect(pairingErrorMessage(new Error('host profile publication was retired'), false, 25)).toBe(
      "Pairing needs to be restarted. The desktop's pairing information changed before setup finished. Open Mobile settings on the desktop and scan the latest QR code."
    )
  })

  it('explains how to retry a pairing timeout', () => {
    expect(pairingErrorMessage(new Error('timeout'), true, 25)).toBe(
      "Couldn't reach your desktop within 25 seconds. Make sure Orca is open on the desktop and both devices are online, then try scanning again."
    )
  })

  it('does not expose an unknown internal pairing error', () => {
    expect(pairingErrorMessage(new Error('relay credential write failed'), false, 25)).toBe(
      'Pairing could not be completed. Make sure Orca is open on the desktop and both devices are online, then try again.'
    )
  })
})
