import { describe, expect, it } from 'vitest'
import type { Translate } from '../i18n/mobile-i18n'
import { getPairingScanErrorMessage } from './pairing-scan-error-message'

const t: Translate = (key) => key

describe('getPairingScanErrorMessage', () => {
  it('recognizes the Android download code on the orca.dev and legacy hosts', () => {
    for (const url of [
      'https://orca.dev/download/android',
      'https://www.orca.dev/download/android',
      'https://onorca.dev/download/android',
      'https://www.onorca.dev/download/android'
    ]) {
      expect(getPairingScanErrorMessage(url, t)).toBe('app.pairScan.downloadQrCode')
    }
  })

  it('treats other orca.dev pages as an invalid code', () => {
    expect(getPairingScanErrorMessage('https://orca.dev/download', t)).toBe(
      'app.pairScan.invalidQrCode'
    )
  })
})
