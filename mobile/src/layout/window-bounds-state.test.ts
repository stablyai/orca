import { describe, expect, it } from 'vitest'
import { resolveWindowBounds } from './window-bounds-state'

describe('resolveWindowBounds', () => {
  it('prefers measured root bounds over display dimensions', () => {
    expect(
      resolveWindowBounds({
        measured: { width: 800, height: 600 },
        fallback: { width: 1920, height: 1080 }
      })
    ).toEqual({ width: 800, height: 600 })
  })

  it('uses display dimensions until root layout is measured', () => {
    expect(resolveWindowBounds({ measured: null, fallback: { width: 390, height: 844 } })).toEqual({
      width: 390,
      height: 844
    })
  })
})
