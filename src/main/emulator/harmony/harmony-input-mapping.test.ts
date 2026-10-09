import { describe, expect, it } from 'vitest'
import { harmonyButtonKeycode, normalizedToDevicePixels } from './harmony-input-mapping'

describe('normalizedToDevicePixels', () => {
  const size = { width: 100, height: 200 }

  it('scales and rounds', () => {
    expect(normalizedToDevicePixels(0.5, 0.25, size)).toEqual({ x: 50, y: 50 })
  })

  it('clamps to the 0..dimension-1 range', () => {
    expect(normalizedToDevicePixels(-1, 2, size)).toEqual({ x: 0, y: 199 })
  })

  it('maps 1 to the final addressable pixel', () => {
    expect(normalizedToDevicePixels(1, 1, size)).toEqual({ x: 99, y: 199 })
  })
})

describe('harmonyButtonKeycode', () => {
  it('maps documented buttons and aliases', () => {
    expect(harmonyButtonKeycode('home')).toBe(1)
    expect(harmonyButtonKeycode('back')).toBe(2)
    expect(harmonyButtonKeycode('recents')).toBe(2210)
    expect(harmonyButtonKeycode('app_switch')).toBe(2210)
    expect(harmonyButtonKeycode('power')).toBe(18)
    expect(harmonyButtonKeycode('volume_up')).toBe(16)
    expect(harmonyButtonKeycode('volume_down')).toBe(17)
  })

  it('throws for unknown buttons', () => {
    expect(() => harmonyButtonKeycode('siri')).toThrow(
      expect.objectContaining({
        code: 'emulator_error',
        message: 'Unknown HarmonyOS hardware button: siri'
      })
    )
  })
})
