import { describe, expect, it } from 'vitest'
import { EmulatorError } from '../emulator-errors'
import {
  androidButtonKeycode,
  normalizedToDevicePixels,
  type DeviceScreenSize
} from './android-input-mapping'

const PIXEL_7: DeviceScreenSize = { width: 1080, height: 2340 }

describe('normalizedToDevicePixels', () => {
  it('maps center to the middle pixel', () => {
    expect(normalizedToDevicePixels(0.5, 0.5, PIXEL_7)).toEqual({ x: 540, y: 1170 })
  })

  it('maps the top-left origin to {0, 0}', () => {
    expect(normalizedToDevicePixels(0, 0, PIXEL_7)).toEqual({ x: 0, y: 0 })
  })

  it('clamps the bottom-right edge to width-1/height-1', () => {
    expect(normalizedToDevicePixels(1, 1, PIXEL_7)).toEqual({ x: 1079, y: 2339 })
  })

  it('clamps negative inputs to the leading edge', () => {
    expect(normalizedToDevicePixels(-0.5, -0.5, PIXEL_7)).toEqual({ x: 0, y: 0 })
  })

  it('clamps inputs above 1 to the trailing edge', () => {
    expect(normalizedToDevicePixels(1.5, 1.5, PIXEL_7)).toEqual({ x: 1079, y: 2339 })
  })

  it('rounds to the nearest pixel', () => {
    // 0.4999 * 1080 = 539.892 -> 540 (rounds up)
    expect(normalizedToDevicePixels(0.4999, 0, PIXEL_7).x).toBe(540)
    // 0.5002 * 1080 = 540.216 -> 540 (rounds down)
    expect(normalizedToDevicePixels(0.5002, 0, PIXEL_7).x).toBe(540)
    // 0.5008 * 1080 = 540.864 -> 541 (rounds up)
    expect(normalizedToDevicePixels(0.5008, 0, PIXEL_7).x).toBe(541)
  })
})

describe('androidButtonKeycode', () => {
  const cases: [string, number][] = [
    ['home', 3],
    ['back', 4],
    ['recents', 187],
    ['app_switch', 187],
    ['recent', 187],
    ['overview', 187],
    ['power', 26],
    ['lock', 26],
    ['volume_up', 24],
    ['volup', 24],
    ['volume_down', 25],
    ['voldown', 25]
  ]

  it.each(cases)('maps %s to keycode %i', (name, keycode) => {
    expect(androidButtonKeycode(name)).toBe(keycode)
  })

  it('throws EmulatorError with code emulator_error on unknown name', () => {
    expect(() => androidButtonKeycode('rotate')).toThrowError(EmulatorError)
    try {
      androidButtonKeycode('rotate')
      throw new Error('expected androidButtonKeycode to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(EmulatorError)
      expect((error as EmulatorError).code).toBe('emulator_error')
    }
  })
})
