import { describe, expect, it } from 'vitest'
import { WslHostVisibleWorkByWindow } from './wsl-host-visible-work-windows'

describe('WslHostVisibleWorkByWindow', () => {
  it('unions every window, so one window cannot drop another window’s open work', () => {
    const windows = new WslHostVisibleWorkByWindow()
    expect(windows.report(1, ['wsl:ubuntu'])).toEqual(['wsl:ubuntu'])
    expect(windows.report(2, ['wsl:debian'])).toEqual(['wsl:debian', 'wsl:ubuntu'])
    expect(windows.report(2, [])).toEqual(['wsl:ubuntu'])
    expect(windows.has(2)).toBe(true)
    expect(windows.forget(1)).toEqual([])
    expect(windows.has(1)).toBe(false)
  })
})
