import { RuntimeClientError } from './runtime-client'

export type EmulatorGesturePoint = {
  edge?: number
  type: 'begin' | 'move' | 'end'
  x: number
  y: number
}

export function assertNormalizedCoordinate(value: number, name: string): void {
  if (value < 0 || value > 1) {
    throw new RuntimeClientError('invalid_argument', `--${name} must be between 0 and 1`)
  }
}

export function parseEmulatorGesturePoints(raw: string): EmulatorGesturePoint[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new RuntimeClientError('invalid_argument', '--points must be valid JSON')
  }
  const value =
    parsed && typeof parsed === 'object' && 'points' in parsed
      ? (parsed as { points?: unknown }).points
      : parsed
  if (!Array.isArray(value) || value.length < 2 || value.length > 64) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--points must be an array of 2 to 64 touch points'
    )
  }
  return value.map((point, index) => {
    if (!point || typeof point !== 'object') {
      throw new RuntimeClientError('invalid_argument', `gesture point ${index} must be an object`)
    }
    const candidate = point as Record<string, unknown>
    const type = candidate.type
    const edge = candidate.edge
    const x = candidate.x
    const y = candidate.y
    if (type !== 'begin' && type !== 'move' && type !== 'end') {
      throw new RuntimeClientError(
        'invalid_argument',
        `gesture point ${index} type must be begin, move, or end`
      )
    }
    if (typeof x !== 'number' || !Number.isFinite(x)) {
      throw new RuntimeClientError('invalid_argument', `gesture point ${index} x must be a number`)
    }
    if (typeof y !== 'number' || !Number.isFinite(y)) {
      throw new RuntimeClientError('invalid_argument', `gesture point ${index} y must be a number`)
    }
    assertNormalizedCoordinate(x, `points[${index}].x`)
    assertNormalizedCoordinate(y, `points[${index}].y`)
    if (
      edge !== undefined &&
      (typeof edge !== 'number' || !Number.isInteger(edge) || edge < 0 || edge > 4)
    ) {
      throw new RuntimeClientError(
        'invalid_argument',
        `gesture point ${index} edge must be an integer between 0 and 4`
      )
    }
    return edge === undefined ? { type, x, y } : { type, x, y, edge }
  })
}
