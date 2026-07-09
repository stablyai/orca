import { describe, expect, it } from 'vitest'
import {
  fitHoldModeForLocalHost,
  fitHoldModeForViewer,
  isLocalDesktopOwner,
  LOCAL_DESKTOP_CLIENT_ID
} from './desktop-size-ownership'

describe('desktop-size-ownership', () => {
  it('parks non-owners and clears the owner', () => {
    expect(fitHoldModeForViewer('desktop:a', 'desktop:a')).toBe('desktop-fit')
    expect(fitHoldModeForViewer('desktop:a', 'desktop:b')).toBe('remote-desktop-fit')
    expect(fitHoldModeForViewer(LOCAL_DESKTOP_CLIENT_ID, 'desktop:b')).toBe('remote-desktop-fit')
    expect(fitHoldModeForLocalHost('desktop:remote-1')).toBe('remote-desktop-fit')
    expect(fitHoldModeForLocalHost(LOCAL_DESKTOP_CLIENT_ID)).toBe('desktop-fit')
  })

  it('treats missing owner as local', () => {
    expect(isLocalDesktopOwner(null)).toBe(true)
    expect(isLocalDesktopOwner(undefined)).toBe(true)
    expect(isLocalDesktopOwner(LOCAL_DESKTOP_CLIENT_ID)).toBe(true)
    expect(isLocalDesktopOwner('desktop:other')).toBe(false)
  })
})
