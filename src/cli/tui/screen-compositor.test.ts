import { describe, expect, it } from 'vitest'
import { ScreenCompositor } from './screen-compositor'

function capture(): { write: (chunk: string) => void; out: string[] } {
  const out: string[] = []
  return { write: (chunk) => out.push(chunk), out }
}

describe('ScreenCompositor', () => {
  it('paints every row on the first frame, wrapped in synchronized output', () => {
    const { write, out } = capture()
    new ScreenCompositor(write).render(['a', 'b'])
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('\x1b[?2026h')
    expect(out[0]).toContain('\x1b[?2026l')
    expect(out[0]).toContain('a')
    expect(out[0]).toContain('b')
  })

  it('writes nothing when the next frame is identical', () => {
    const { write, out } = capture()
    const compositor = new ScreenCompositor(write)
    compositor.render(['a', 'b'])
    compositor.render(['a', 'b'])
    expect(out).toHaveLength(1)
  })

  it('rewrites only the changed row', () => {
    const { write, out } = capture()
    const compositor = new ScreenCompositor(write)
    compositor.render(['a', 'b'])
    compositor.render(['a', 'c'])
    expect(out[1]).toContain('c')
    expect(out[1]).not.toContain('a')
  })

  it('clears rows that disappear when the screen shrinks', () => {
    const { write, out } = capture()
    const compositor = new ScreenCompositor(write)
    compositor.render(['a', 'b', 'c'])
    compositor.render(['a'])
    // Rows 1 and 2 are cleared to end-of-line.
    expect(out[1]).toContain('\x1b[K')
  })

  it('repaints all rows after reset()', () => {
    const { write, out } = capture()
    const compositor = new ScreenCompositor(write)
    compositor.render(['a', 'b'])
    compositor.reset()
    compositor.render(['a', 'b'])
    expect(out).toHaveLength(2)
  })
})
