import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({ PanResponder: { create: vi.fn() } }))

import {
  readMobileMaestroTouchPoint,
  shouldActivateMobileMaestroGesture
} from './use-mobile-maestro-gestures'

describe('mobile Maestro gestures', () => {
  it('starts a stationary two-finger pinch immediately', () => {
    expect(shouldActivateMobileMaestroGesture(2, { x: 0, y: 0 })).toBe(true)
  })

  it('waits for deliberate movement before starting one-finger pan', () => {
    expect(shouldActivateMobileMaestroGesture(1, { x: 2, y: 2 })).toBe(false)
    expect(shouldActivateMobileMaestroGesture(1, { x: 4, y: 0 })).toBe(true)
  })

  it('reads stable page coordinates relative to the board', () => {
    expect(
      readMobileMaestroTouchPoint(
        { pageX: 240, pageY: 360, locationX: 12, locationY: 18 },
        { x: 40, y: 80 }
      )
    ).toEqual({ x: 200, y: 280 })
  })
})
