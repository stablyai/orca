import { describe, expect, it } from 'vitest'
import { buildAppFontFamily } from './app-font-family'

describe('buildAppFontFamily', () => {
  it('leaves a keyword bare and lists each fallback the setting does not name', () => {
    expect(buildAppFontFamily('')).toBe(
      '"Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    )
    expect(buildAppFontFamily('segoe ui')).toBe(
      '"segoe ui", "Geist", -apple-system, BlinkMacSystemFont, sans-serif'
    )
    expect(buildAppFontFamily('system-ui')).toBe(
      'system-ui, "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    )
  })
})
