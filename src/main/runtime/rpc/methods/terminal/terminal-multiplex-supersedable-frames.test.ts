import { describe, expect, it } from 'vitest'
import { TerminalStreamOpcode } from '../../../../../shared/terminal/stream/terminal-stream-protocol'
import { framesAreSupersedable } from './terminal-multiplex-supersedable-frames'

const frame = (text: string) => ({
  bytes: new TextEncoder().encode(text),
  displayLength: text.length
})

describe('framesAreSupersedable', () => {
  it('accepts plain alt-screen repaint frames, including OSC titles', () => {
    expect(
      framesAreSupersedable('', [
        frame('\x1b]0;agent\x07\x1b[H\x1b[2Kframe 1'),
        frame('\x1b[Hframe 2')
      ])
    ).toBe(true)
  })

  it('rejects a screen switch split across queued frames', () => {
    expect(framesAreSupersedable('', [frame('log line\x1b[?10'), frame('49h\x1b[H')])).toBe(false)
  })

  it('rejects a screen switch split across the send boundary', () => {
    expect(framesAreSupersedable('\x1b[?1', [frame('047l prompt')])).toBe(false)
  })

  it('rejects a bell and a clipboard write', () => {
    expect(framesAreSupersedable('', [frame('done\x07')])).toBe(false)
    expect(framesAreSupersedable('', [frame('\x1b]52;c;aGk=\x07')])).toBe(false)
  })

  it('rejects span frames and an unknown send boundary', () => {
    const span = { ...frame('{"data":"x"}'), opcode: TerminalStreamOpcode.OutputSpan }
    expect(framesAreSupersedable('', [span])).toBe(false)
    expect(framesAreSupersedable(null, [frame('x')])).toBe(false)
  })
})
