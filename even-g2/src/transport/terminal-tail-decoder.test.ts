import { describe, expect, it } from 'vitest'
import {
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

  it('resets the buffer on SnapshotStart, then appends SnapshotChunk/SnapshotEnd', () => {
    const decoder = new TerminalTailDecoder()
    decoder.pushFrame(frame(TerminalStreamOpcode.Output, 'stale line\n'))
    decoder.pushFrame(frame(TerminalStreamOpcode.SnapshotStart, 'fresh-'))
    decoder.pushFrame(frame(TerminalStreamOpcode.SnapshotChunk, 'start\n'))
    decoder.pushFrame(frame(TerminalStreamOpcode.SnapshotChunk, 'second line'))
    decoder.pushFrame(frame(TerminalStreamOpcode.SnapshotEnd, ''))
    expect(decoder.lines()).toEqual(['fresh-start', 'second line'])
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
})
