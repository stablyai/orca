import { describe, expect, it } from 'vitest'
import { DoubleEscapeDetector } from './double-escape'

const ESC = '\x1b'

describe('DoubleEscapeDetector', () => {
  it('exits on two lone Escs within the window (first passes through)', () => {
    const d = new DoubleEscapeDetector(600)
    expect(d.test(ESC, 1000)).toBe(false)
    expect(d.test(ESC, 1300)).toBe(true)
  })

  it('does not exit when the two Escs are too far apart', () => {
    const d = new DoubleEscapeDetector(600)
    expect(d.test(ESC, 1000)).toBe(false)
    expect(d.test(ESC, 2000)).toBe(false)
  })

  it('exits on a batched double-Esc in one read', () => {
    expect(new DoubleEscapeDetector().test(`${ESC}${ESC}`, 0)).toBe(true)
  })

  it('ignores non-Esc input', () => {
    expect(new DoubleEscapeDetector().test('a', 0)).toBe(false)
  })
})
