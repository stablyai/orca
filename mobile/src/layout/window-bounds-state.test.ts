import { describe, expect, it } from 'vitest'
import { resolveWindowBounds } from './window-bounds-state'

describe('window bounds resolution', () => {
  it('uses measured root bounds when available', () => {
    expect(
      resolveWindowBounds({
        measured: { width: 1000, height: 700 },
        fallback: { width: 1080, height: 2400 }
      })
    ).toEqual({ width: 1000, height: 700 })
  })

  it('falls back to React Native dimensions until root layout is measured', () => {
    expect(
      resolveWindowBounds({ measured: null, fallback: { width: 1080, height: 2400 } })
    ).toEqual({
      width: 1080,
      height: 2400
    })
    expect(
      resolveWindowBounds({
        measured: { width: 0, height: 700 },
        fallback: { width: 1080, height: 2400 }
      })
    ).toEqual({ width: 1080, height: 2400 })
  })
})
