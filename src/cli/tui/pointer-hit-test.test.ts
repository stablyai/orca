import { describe, expect, it } from 'vitest'
import { hitTest, type HitTarget } from './pointer-hit-test'

const targets: HitTarget<string>[] = [
  { rect: { x: 0, y: 0, width: 20, height: 1 }, value: 'wt-a' },
  { rect: { x: 0, y: 1, width: 20, height: 1 }, value: 'wt-b' },
  { rect: { x: 22, y: 0, width: 30, height: 5 }, value: 'detail' }
]

describe('hitTest', () => {
  it('resolves a click to the target row under the pointer', () => {
    expect(hitTest(targets, 5, 0)).toBe('wt-a')
    expect(hitTest(targets, 5, 1)).toBe('wt-b')
    expect(hitTest(targets, 30, 2)).toBe('detail')
  })

  it('returns null for a click in a gutter / empty region', () => {
    expect(hitTest(targets, 21, 0)).toBeNull()
    expect(hitTest(targets, 5, 9)).toBeNull()
  })

  it('treats width/height as half-open (right/bottom edge excluded)', () => {
    expect(hitTest(targets, 20, 0)).toBeNull()
    expect(hitTest([{ rect: { x: 0, y: 0, width: 1, height: 1 }, value: 'x' }], 0, 0)).toBe('x')
  })
})
