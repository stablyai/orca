import { describe, expect, it } from 'vitest'
import { getBuiltinTerminalThemePalette } from '../../../src/shared/terminal-themes'
import type { MobileTerminalThemeSelection } from '../storage/terminal-theme-preference'
import { selectMobileTerminalTheme } from './terminal-theme-slot-selection'
import type { MobileTerminalTheme } from './terminal-webview-contract'

const FOLLOW_DESKTOP: MobileTerminalThemeSelection = {
  dark: null,
  light: null,
  useSeparateLightTheme: true
}

const hostTheme: MobileTerminalTheme = {
  mode: 'dark',
  theme: { background: '#101010', foreground: '#f0f0f0' }
}

describe('selectMobileTerminalTheme', () => {
  it('passes the host palette through when no slot is chosen', () => {
    expect(selectMobileTerminalTheme(FOLLOW_DESKTOP, 'dark', hostTheme)).toBe(hostTheme)
  })

  it('stays undefined when no slot is chosen and no host palette arrived', () => {
    expect(selectMobileTerminalTheme(FOLLOW_DESKTOP, 'dark', undefined)).toBeUndefined()
  })

  it('lets the device dark slot win over the host palette', () => {
    expect(
      selectMobileTerminalTheme({ ...FOLLOW_DESKTOP, dark: 'One Dark' }, 'dark', hostTheme)
    ).toEqual({ mode: 'dark', theme: getBuiltinTerminalThemePalette('One Dark') })
  })

  it('applies the device dark slot on a headless host that pushes nothing', () => {
    expect(
      selectMobileTerminalTheme({ ...FOLLOW_DESKTOP, dark: 'One Dark' }, 'dark', undefined)
    ).toEqual({ mode: 'dark', theme: getBuiltinTerminalThemePalette('One Dark') })
  })

  it('falls back to the host palette for an uncatalogued slot name', () => {
    const selection = { ...FOLLOW_DESKTOP, dark: 'Theme That Was Renamed' }
    expect(selectMobileTerminalTheme(selection, 'dark', hostTheme)).toBe(hostTheme)
    expect(selectMobileTerminalTheme(selection, 'dark', undefined)).toBeUndefined()
  })

  it('uses the light slot in light mode when a separate light theme is enabled', () => {
    expect(
      selectMobileTerminalTheme(
        { dark: 'One Dark', light: 'GitHub Light', useSeparateLightTheme: true },
        'light',
        hostTheme
      )
    ).toEqual({ mode: 'light', theme: getBuiltinTerminalThemePalette('GitHub Light') })
  })

  it('mirrors desktop: light mode without a separate light theme uses the dark slot', () => {
    expect(
      selectMobileTerminalTheme(
        { dark: 'One Dark', light: 'GitHub Light', useSeparateLightTheme: false },
        'light',
        hostTheme
      )
    ).toEqual({ mode: 'light', theme: getBuiltinTerminalThemePalette('One Dark') })
  })

  it('follows the host in light mode when only the dark slot is chosen', () => {
    expect(
      selectMobileTerminalTheme({ ...FOLLOW_DESKTOP, dark: 'One Dark' }, 'light', hostTheme)
    ).toBe(hostTheme)
  })
})
