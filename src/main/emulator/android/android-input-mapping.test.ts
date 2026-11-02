import { describe, expect, it } from 'vitest'
import { EmulatorError } from '../emulator-errors'
import {
  androidButtonKeycode,
  normalizedToDevicePixels,
  type DeviceScreenSize
} from './android-input-mapping'

const PIXEL_7: DeviceScreenSize = { width: 1080, height: 2340 }

describe('normalizedToDevicePixels', () => {
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
    expect(normalizedToDevicePixels(0.4999, 0, PIXEL_7).x).toBe(540)
    expect(normalizedToDevicePixels(0.5002, 0, PIXEL_7).x).toBe(540)
    expect(normalizedToDevicePixels(0.5008, 0, PIXEL_7).x).toBe(541)
  })
})

describe('androidButtonKeycode', () => {
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
