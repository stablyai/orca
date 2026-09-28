import { describe, expect, it } from 'vitest'
import { buildSafeAreaScript, parseThemeMessage } from './desktop-webview-bridge'

describe('desktop webview bridge', () => {
  it('hands every inset to the page as a rounded, non-negative px variable', () => {
    const script = buildSafeAreaScript({ top: 24.6, right: 0, bottom: 47.9, left: -2 })
    expect(script).toContain("s.setProperty('--app-safe-top','25px');")
    expect(script).toContain("s.setProperty('--app-safe-right','0px');")
    expect(script).toContain("s.setProperty('--app-safe-bottom','48px');")
    expect(script).toContain("s.setProperty('--app-safe-left','0px');")
    expect(script.endsWith('true;')).toBe(true)
  })

  it('accepts only well-formed theme reports', () => {
    expect(parseThemeMessage('{"type":"orca-desktop-theme","dark":true}')).toBe(true)
    expect(parseThemeMessage('{"type":"orca-desktop-theme","dark":false}')).toBe(false)
    expect(parseThemeMessage('{"type":"orca-desktop-theme","dark":"yes"}')).toBeNull()
    expect(parseThemeMessage('{"type":"other","dark":true}')).toBeNull()
    expect(parseThemeMessage('not json')).toBeNull()
  })
})
