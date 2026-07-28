import { describe, expect, it } from 'vitest'
import { assertNormalizedCoordinate, parseEmulatorGesturePoints } from './emulator-gesture-args'
import { RuntimeClientError } from './runtime-client'

function expectInvalidArgument(run: () => unknown, message?: string): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeClientError)
    expect((error as RuntimeClientError).code).toBe('invalid_argument')
    if (message !== undefined) {
      expect((error as RuntimeClientError).message).toContain(message)
    }
    return
  }
  throw new Error('expected an invalid_argument error')
}

describe('assertNormalizedCoordinate', () => {
  it('accepts the closed 0..1 range', () => {
    expect(() => assertNormalizedCoordinate(0, 'x')).not.toThrow()
    expect(() => assertNormalizedCoordinate(1, 'x')).not.toThrow()
    expect(() => assertNormalizedCoordinate(0.5, 'x')).not.toThrow()
  })

  it('rejects values outside 0..1 and names the flag', () => {
    expectInvalidArgument(
      () => assertNormalizedCoordinate(-0.01, 'x'),
      '--x must be between 0 and 1'
    )
    expectInvalidArgument(
      () => assertNormalizedCoordinate(1.01, 'y'),
      '--y must be between 0 and 1'
    )
  })
})

describe('parseEmulatorGesturePoints', () => {
  const twoPoints = '[{"type":"begin","x":0.1,"y":0.2},{"type":"end","x":0.3,"y":0.4}]'

  it('parses a bare array', () => {
    expect(parseEmulatorGesturePoints(twoPoints)).toEqual([
      { type: 'begin', x: 0.1, y: 0.2 },
      { type: 'end', x: 0.3, y: 0.4 }
    ])
  })

  it('unwraps a points envelope', () => {
    expect(parseEmulatorGesturePoints(`{"points":${twoPoints}}`)).toHaveLength(2)
  })

  it('keeps an explicit edge and omits it otherwise', () => {
    const parsed = parseEmulatorGesturePoints(
      '[{"type":"begin","x":0,"y":0,"edge":2},{"type":"end","x":1,"y":1}]'
    )
    expect(parsed[0]).toEqual({ type: 'begin', x: 0, y: 0, edge: 2 })
    expect(parsed[1]).not.toHaveProperty('edge')
  })

  it('rejects malformed JSON', () => {
    expectInvalidArgument(() => parseEmulatorGesturePoints('{nope'), '--points must be valid JSON')
  })

  it('rejects fewer than 2 or more than 64 points', () => {
    expectInvalidArgument(
      () => parseEmulatorGesturePoints('[{"type":"begin","x":0,"y":0}]'),
      '2 to 64 touch points'
    )
    const tooMany = JSON.stringify(
      Array.from({ length: 65 }, () => ({ type: 'move', x: 0.5, y: 0.5 }))
    )
    expectInvalidArgument(() => parseEmulatorGesturePoints(tooMany), '2 to 64 touch points')
  })

  it('rejects a bad point type, non-numeric coords, and out-of-range coords', () => {
    expectInvalidArgument(
      () => parseEmulatorGesturePoints('[{"type":"tap","x":0,"y":0},{"type":"end","x":1,"y":1}]'),
      'gesture point 0 type must be begin, move, or end'
    )
    expectInvalidArgument(
      () =>
        parseEmulatorGesturePoints('[{"type":"begin","x":"a","y":0},{"type":"end","x":1,"y":1}]'),
      'gesture point 0 x must be a number'
    )
    expectInvalidArgument(
      () => parseEmulatorGesturePoints('[{"type":"begin","x":0,"y":2},{"type":"end","x":1,"y":1}]'),
      '--points[0].y must be between 0 and 1'
    )
  })

  it('rejects a non-object point and a non-integer or out-of-range edge', () => {
    expectInvalidArgument(
      () => parseEmulatorGesturePoints('[3,{"type":"end","x":1,"y":1}]'),
      'gesture point 0 must be an object'
    )
    expectInvalidArgument(
      () =>
        parseEmulatorGesturePoints(
          '[{"type":"begin","x":0,"y":0,"edge":5},{"type":"end","x":1,"y":1}]'
        ),
      'gesture point 0 edge must be an integer between 0 and 4'
    )
  })
})
