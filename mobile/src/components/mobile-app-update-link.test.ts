import { describe, expect, it } from 'vitest'
import { getMobileAppUpdateUrl } from './mobile-app-update-link'

describe('getMobileAppUpdateUrl', () => {
  it('uses the native App Store listing on iOS', () => {
    expect(getMobileAppUpdateUrl('ios')).toBe(
      'itms-apps://apps.apple.com/app/orca-ide/id6766130217'
    )
  })

  it('links Android to the mobile-filtered GitHub releases list', () => {
    expect(getMobileAppUpdateUrl('android')).toBe(
      'https://github.com/stablyai/orca/releases?q=mobile-android'
    )
  })

  it('fails open without a supported distribution', () => {
    expect(getMobileAppUpdateUrl('web')).toBeNull()
  })
})
