import { describe, expect, it } from 'vitest'
import { EmulatorError } from '../emulator-errors'
import { parseAndroidBounds, parseUiAutomatorXml } from './uiautomator-tree'

describe('parseUiAutomatorXml', () => {
  it('throws EmulatorError(emulator_error) on truncated XML', () => {
    const truncated = '<hierarchy><node class="a"'
    expect(() => parseUiAutomatorXml(truncated)).toThrowError(EmulatorError)
    try {
      parseUiAutomatorXml(truncated)
      throw new Error('expected parseUiAutomatorXml to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(EmulatorError)
      expect((error as EmulatorError).code).toBe('emulator_error')
    }
  })
})

describe('parseAndroidBounds', () => {
  it('parses negative coordinates for off-screen elements', () => {
    expect(parseAndroidBounds('[-5,10][1080,2340]')).toEqual({
      left: -5,
      top: 10,
      right: 1080,
      bottom: 2340
    })
  })
})
