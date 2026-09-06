import { describe, expect, it } from 'vitest'
import { snapTerminalTextScale } from './terminal-web-text-zoom'

describe('hosted terminal text zoom', () => {
  it('snaps pinch results to the existing terminal text-size presets', () => {
    expect(snapTerminalTextScale(0.62)).toBe(0.5)
    expect(snapTerminalTextScale(0.63)).toBe(0.75)
    expect(snapTerminalTextScale(1.12)).toBe(1)
    expect(snapTerminalTextScale(1.13)).toBe(1.25)
    expect(snapTerminalTextScale(1.9)).toBe(2)
  })
})
