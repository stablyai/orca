import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONIN_BARE_ESC_FLUSH_MS,
  CONIN_PARTIAL_SEQUENCE_FLUSH_MS,
  ConinAtomicSequenceWriter
} from './conin-atomic-sequence-writer'
import { MAX_PARTIAL_ESCAPE_TAIL_LENGTH } from '../../shared/terminal-partial-escape-tail'

describe('ConinAtomicSequenceWriter', () => {
  let written: string[]
  let writer: ConinAtomicSequenceWriter

  beforeEach(() => {
    vi.useFakeTimers()
    written = []
    writer = new ConinAtomicSequenceWriter((data) => written.push(data))
  })

  afterEach(() => {
    writer.dispose()
    vi.useRealTimers()
  })

  it('passes complete chunks through unchanged with no added latency', () => {
    writer.write('\x7f')
    writer.write('hello')
    writer.write('\x1b[A')
    writer.write('\x1b[200~pasted text\x1b[201~')
    expect(written).toEqual(['\x7f', 'hello', '\x1b[A', '\x1b[200~pasted text\x1b[201~'])
  })

  // The field failure: ConPTY swallows a split sequence's head and types its
  // tail as literal keystrokes (repro: split `\x1b[?997;1` + `n` delivers "n").
  it('joins a CSI split across two writes into one atomic write', () => {
    writer.write('\x1b[?997;1')
    expect(written).toEqual([])
    writer.write('n')
    expect(written).toEqual(['\x1b[?997;1n'])
  })

  it('joins a split bracketed-paste end marker', () => {
    writer.write('\x1b[200~hi\x1b[')
    expect(written).toEqual(['\x1b[200~hi'])
    writer.write('201~')
    expect(written).toEqual(['\x1b[200~hi', '\x1b[201~'])
  })

  it('joins a split DCS reply', () => {
    writer.write('\x1bP>|xterm.js')
    expect(written).toEqual([])
    writer.write('(5.5.0)\x1b\\')
    expect(written).toEqual(['\x1bP>|xterm.js(5.5.0)\x1b\\'])
  })

  it('flushes a bare ESC keypress after the short window', () => {
    writer.write('\x1b')
    expect(written).toEqual([])
    vi.advanceTimersByTime(CONIN_BARE_ESC_FLUSH_MS)
    expect(written).toEqual(['\x1b'])
  })

  it('does not fuse ESC with a following independent keypress into an Alt-chord', () => {
    writer.write('\x1b')
    writer.write('a')
    // Two separate writes: ESC key, then the letter — never '\x1ba' (Alt+A).
    expect(written).toEqual(['\x1b', 'a'])
  })

  it('does not fuse ESC with a following backspace into Alt+Backspace', () => {
    writer.write('\x1b')
    writer.write('\x7f')
    expect(written).toEqual(['\x1b', '\x7f'])
  })

  it('joins ESC with a genuine sequence continuation', () => {
    writer.write('\x1b')
    writer.write('[I')
    expect(written).toEqual(['\x1b[I'])
  })

  it('flushes a dangling non-ESC partial after the long window', () => {
    writer.write('\x1b[?99')
    vi.advanceTimersByTime(CONIN_PARTIAL_SEQUENCE_FLUSH_MS - 1)
    expect(written).toEqual([])
    vi.advanceTimersByTime(1)
    expect(written).toEqual(['\x1b[?99'])
  })

  it('keeps a real Alt-chord sent as one write intact', () => {
    writer.write('\x1ba')
    expect(written).toEqual(['\x1ba'])
  })

  it('writes the complete prefix immediately while holding only the tail', () => {
    writer.write('abc\x1b[?25h\x1b[?20')
    expect(written).toEqual(['abc\x1b[?25h'])
    writer.write('04h\x7f')
    expect(written).toEqual(['abc\x1b[?25h', '\x1b[?2004h\x7f'])
  })

  it('stops guarding past the partial-tail cap', () => {
    const hugeOsc = `\x1b]0;${'x'.repeat(MAX_PARTIAL_ESCAPE_TAIL_LENGTH + 10)}`
    writer.write(hugeOsc)
    expect(written).toEqual([hugeOsc])
    // Subsequent writes pass through (tracking abandoned for that stream).
    writer.write('y')
    expect(written).toEqual([hugeOsc, 'y'])
  })

  it('drops held state on dispose without writing', () => {
    writer.write('\x1b[?99')
    writer.dispose()
    vi.advanceTimersByTime(CONIN_PARTIAL_SEQUENCE_FLUSH_MS)
    expect(written).toEqual([])
    writer.write('x')
    expect(written).toEqual([])
  })

  it('handles a three-way split of one sequence', () => {
    writer.write('\x1b')
    writer.write('[?9')
    writer.write('97;1n\x7f')
    expect(written).toEqual(['\x1b[?997;1n\x7f'])
  })

  it('flushes at most once per held tail when the timer races a continuation', () => {
    writer.write('\x1b[?99')
    vi.advanceTimersByTime(CONIN_PARTIAL_SEQUENCE_FLUSH_MS)
    expect(written).toEqual(['\x1b[?99'])
    // Continuation after the flush degrades to pre-guard behavior: literal tail.
    writer.write('7;1n')
    expect(written).toEqual(['\x1b[?99', '7;1n'])
  })
})
