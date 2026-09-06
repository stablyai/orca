import { describe, expect, it } from 'vitest'
import {
  encodeTerminalStreamJson,
  TerminalStreamOpcode,
  type TerminalStreamFrame
} from '@orca-shared/terminal-stream-protocol'
import { TerminalTailDecoder } from './terminal-tail-decoder'

function frame(
  opcode: TerminalStreamOpcode,
  text: string,
  streamId = 1,
  seq = 0
): TerminalStreamFrame {
  return { opcode, streamId, seq, payload: new TextEncoder().encode(text) }
}

describe('TerminalTailDecoder', () => {
  it('strips ANSI/CSI/OSC sequences from output', () => {
    const decoder = new TerminalTailDecoder()
    decoder.pushFrame(frame(TerminalStreamOpcode.Output, '\x1b[31mred\x1b[0m text\n'))
    expect(decoder.lines()).toEqual(['red text'])
  })

  it('strips OSC sequences terminated by BEL and by ST', () => {
    const decoder = new TerminalTailDecoder()
    decoder.pushFrame(
      frame(TerminalStreamOpcode.Output, '\x1b]0;title\x07hello\x1b]2;other\x1b\\world\n')
    )
    expect(decoder.lines()).toEqual(['helloworld'])
  })

  it('expands tabs', () => {
    const decoder = new TerminalTailDecoder()
    decoder.pushFrame(frame(TerminalStreamOpcode.Output, 'a\tb\n'))
    expect(decoder.lines()).toEqual(['a       b'])
  })

  it('hard-wraps lines longer than maxCols', () => {
    const decoder = new TerminalTailDecoder({ maxCols: 5 })
    decoder.pushFrame(frame(TerminalStreamOpcode.Output, '0123456789\n'))
    expect(decoder.lines()).toEqual(['01234', '56789'])
  })

  it('accumulates a partial line across multiple Output frames', () => {
    const decoder = new TerminalTailDecoder()
    decoder.pushFrame(frame(TerminalStreamOpcode.Output, 'hel'))
    decoder.pushFrame(frame(TerminalStreamOpcode.Output, 'lo\n'))
    decoder.pushFrame(frame(TerminalStreamOpcode.Output, 'world'))
    expect(decoder.lines()).toEqual(['hello', 'world'])
  })

  it('keeps only the last maxLines lines', () => {
    const decoder = new TerminalTailDecoder({ maxLines: 3 })
    for (let i = 0; i < 10; i++) {
      decoder.pushFrame(frame(TerminalStreamOpcode.Output, `line-${i}\n`))
    }
    expect(decoder.lines()).toEqual(['line-7', 'line-8', 'line-9'])
  })

  it('resets the buffer on SnapshotStart and does not render its JSON metadata payload, then appends SnapshotChunk/SnapshotEnd', () => {
    const decoder = new TerminalTailDecoder()
    decoder.pushFrame(frame(TerminalStreamOpcode.Output, 'stale line\n'))
    decoder.pushFrame({
      opcode: TerminalStreamOpcode.SnapshotStart,
      streamId: 1,
      seq: 0,
      // Real hosts send JSON metadata here (see terminal-snapshot-publication.ts), not text.
      payload: encodeTerminalStreamJson({ kind: 'scrollback', cols: 80, rows: 24 })
    })
    decoder.pushFrame(frame(TerminalStreamOpcode.SnapshotChunk, 'start\n'))
    decoder.pushFrame(frame(TerminalStreamOpcode.SnapshotChunk, 'second line'))
    decoder.pushFrame(frame(TerminalStreamOpcode.SnapshotEnd, ''))
    expect(decoder.lines()).toEqual(['start', 'second line'])
  })

  it('never contaminates lines() with SnapshotStart metadata, even when it looks like text', () => {
    const decoder = new TerminalTailDecoder()
    decoder.pushFrame({
      opcode: TerminalStreamOpcode.SnapshotStart,
      streamId: 1,
      seq: 0,
      payload: encodeTerminalStreamJson({
        kind: 'scrollback',
        cols: 80,
        rows: 24,
        cwd: '/Users/dev/should-not-appear-in-tail'
      })
    })
    expect(decoder.lines()).toEqual([''])
    decoder.pushFrame(frame(TerminalStreamOpcode.SnapshotChunk, 'real output\n'))
    expect(decoder.lines()).toEqual(['real output'])
  })

  it('renders Error frames as an inline marker line', () => {
    const decoder = new TerminalTailDecoder()
    decoder.pushFrame(frame(TerminalStreamOpcode.Output, 'before\n'))
    decoder.pushFrame(frame(TerminalStreamOpcode.Error, 'pty closed'))
    expect(decoder.lines()).toEqual(['before', '', '[error] pty closed'])
  })

  it('ignores Resized frames', () => {
    const decoder = new TerminalTailDecoder()
    decoder.pushFrame(frame(TerminalStreamOpcode.Output, 'line one\n'))
    decoder.pushFrame({
      opcode: TerminalStreamOpcode.Resized,
      streamId: 1,
      seq: 0,
      payload: new Uint8Array()
    })
    decoder.pushFrame(frame(TerminalStreamOpcode.Output, 'line two\n'))
    expect(decoder.lines()).toEqual(['line one', 'line two'])
  })

  it('starts with an empty lines() before any frame', () => {
    const decoder = new TerminalTailDecoder()
    expect(decoder.lines()).toEqual([''])
  })

  // Finding #20: a busy terminal must not grow WebView memory unbounded — retention is capped
  // during ingestion (as frames arrive), not only when lines() is finally read.
  it('bounds retained lines during ingestion, not just at read time', () => {
    const decoder = new TerminalTailDecoder({ maxLines: 3 })
    for (let i = 0; i < 1000; i++) {
      decoder.pushFrame(frame(TerminalStreamOpcode.Output, `line-${i}\n`))
      // Never allowed to grow past maxLines + the small retention margin at any point.
      expect(decoder.retainedLineCount()).toBeLessThan(40)
    }
    expect(decoder.lines()).toEqual(['line-997', 'line-998', 'line-999'])
  })
})
