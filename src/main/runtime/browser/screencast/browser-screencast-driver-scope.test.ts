import { describe, expect, it } from 'vitest'
import {
  resolveBrowserDriverAfterMobileRelease,
  screencastSubscriberDrivesAsMobile,
  type BrowserScreencastSubscriber
} from './browser-screencast-driver-scope'

function subscriber(connectionKey: string, drivesAsMobile: boolean): BrowserScreencastSubscriber {
  return { cancel: () => {}, done: Promise.resolve(), connectionKey, drivesAsMobile }
}

describe('screencastSubscriberDrivesAsMobile', () => {
  it('admits only mobile-scoped pairings', () => {
    expect(screencastSubscriberDrivesAsMobile('mobile')).toBe(true)
    expect(screencastSubscriberDrivesAsMobile('runtime')).toBe(false)
    expect(screencastSubscriberDrivesAsMobile(undefined)).toBe(false)
  })
})

describe('resolveBrowserDriverAfterMobileRelease', () => {
  it('hands the lock to the newest remaining mobile subscriber', () => {
    expect(
      resolveBrowserDriverAfterMobileRelease([
        subscriber('conn-phone-a', true),
        subscriber('conn-phone-b', true)
      ])
    ).toEqual({ kind: 'mobile', clientId: 'conn-phone-b' })
  })

  it('goes idle rather than promoting a desktop viewer that is still watching', () => {
    expect(
      resolveBrowserDriverAfterMobileRelease([
        subscriber('conn-desktop-a', false),
        subscriber('conn-desktop-b', false)
      ])
    ).toEqual({ kind: 'idle' })
  })

  it('skips past a later desktop viewer to the remaining phone', () => {
    expect(
      resolveBrowserDriverAfterMobileRelease([
        subscriber('conn-phone', true),
        subscriber('conn-desktop', false)
      ])
    ).toEqual({ kind: 'mobile', clientId: 'conn-phone' })
  })

  it('goes idle when nothing is left', () => {
    expect(resolveBrowserDriverAfterMobileRelease([])).toEqual({ kind: 'idle' })
  })
})
