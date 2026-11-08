import { describe, expect, it } from 'vitest'
import { framesAreSupersedable } from './terminal-multiplex-supersedable-frames'

const frame = (text: string) => ({
  bytes: new TextEncoder().encode(text),
  displayLength: text.length
})
const noTail = new Uint8Array()

describe('framesAreSupersedable', () => {
  it('accepts alt-screen repaint frames', () => {
    expect(
      framesAreSupersedable(noTail, [frame('\x1b[H\x1b[2Kframe 1'), frame('\x1b[Hframe 2')])
    ).toBe(true)
  })

  it('rejects a screen switch split across queued frames', () => {
    expect(framesAreSupersedable(noTail, [frame('log line\x1b[?10'), frame('49h\x1b[H')])).toBe(
      false
    )
  })

  it('rejects a screen switch split across the last sent frame', () => {
    expect(framesAreSupersedable(new TextEncoder().encode('[?1'), [frame('047l prompt')])).toBe(
      false
    )
  })

  it('rejects a JSON-escaped clipboard write in a span frame', () => {
    expect(framesAreSupersedable(noTail, [frame('{"data":"\\u001b]52;c;aGk=\\u0007"}')])).toBe(
      false
    )
  })
})
