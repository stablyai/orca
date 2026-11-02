import { describe, expect, it } from 'vitest'
import { normalizeTerminalChunk } from './terminal-ansi-normalization'
import { appendNormalizedToTailBuffer } from './terminal-tail-buffer'
import type { RetainedTailRedrawCursor } from './terminal-tail-redraw-buffer'
import { MAX_TAIL_PARTIAL_CHARS } from './terminal-tail-limits'
import { readPtyTail, runtimeWithLeaf } from './orca-runtime-pty-leaf.test-fixture'

function ingestChunks(chunks: string[]) {
  let lines: string[] = []
  let partialLine = ''
  let pendingAnsi = ''
  let redrawCursor: RetainedTailRedrawCursor | null = null
  let completeLines = 0
  const completed: string[] = []
  for (const chunk of chunks) {
    const normalized = normalizeTerminalChunk(chunk, pendingAnsi)
    pendingAnsi = normalized.pendingAnsi
    const next = appendNormalizedToTailBuffer(lines, partialLine, normalized.text, redrawCursor)
    lines = next.lines
    partialLine = next.partialLine
    redrawCursor = next.redrawCursor
    completeLines += next.newCompleteLines
    completed.push(...next.newlyCompletedLines)
    expect(next.truncated).toBe(false)
  }
  return { lines, partialLine, pendingAnsi, completeLines, completed }
}

describe('terminal tail CRLF chunk boundaries', () => {
  it('retains the reported base64 line when CR and LF arrive separately', () => {
    expect(ingestChunks(['QUJDRA==\r', '\n'])).toEqual({
      lines: ['QUJDRA=='],
      partialLine: '',
      pendingAnsi: '',
      completeLines: 1,
      completed: ['QUJDRA==']
    })
  })

  it('retains content and line counts at every boundary, including empty chunks', () => {
    const output = '\r\nfirst\r\n\r\nsecond\r\nlast'
    const expected = ingestChunks([output])
    for (let boundary = 0; boundary <= output.length; boundary += 1) {
      expect(ingestChunks([output.slice(0, boundary), '', output.slice(boundary)])).toEqual(
        expected
      )
    }
    expect(ingestChunks([...output])).toEqual(expected)
  })

  it.each([
    [['old\r', '', 'new\n'], ['new']],
    [['old\r', '\r', 'new\r', '\n'], ['new']],
    [['old\r', '\r\n'], ['']],
    [['old\r', '\x1b[', '2Knew\r', '\n'], ['new']],
    [['\x1b[31', 'mQUJDRA==\r', '\n\x1b[0m'], ['QUJDRA==']],
    [
      ['row one\nrow two\n', '\x1b[1A\x1b[2Kchanged\r', '\n'],
      ['row one', 'changed']
    ]
  ])('preserves standalone redraw and ANSI handling for %j', (chunks, expected) => {
    expect(ingestChunks(chunks).lines).toEqual(expected)
  })

  it('keeps partial retention bounded while a final CR is pending', () => {
    const normalized = normalizeTerminalChunk(`${'x'.repeat(MAX_TAIL_PARTIAL_CHARS * 2)}\r`)
    const partial = appendNormalizedToTailBuffer([], '', normalized.text)
    expect(partial.partialLine).toHaveLength(MAX_TAIL_PARTIAL_CHARS)
    expect(partial.truncated).toBe(true)
    expect(normalized.pendingAnsi).toBe('\r')
    const newline = normalizeTerminalChunk('\n', normalized.pendingAnsi)
    const completed = appendNormalizedToTailBuffer(partial.lines, partial.partialLine, newline.text)
    expect(completed.lines).toEqual(['x'.repeat(MAX_TAIL_PARTIAL_CHARS)])
    expect(completed.newCompleteLines).toBe(1)
    expect(newline.pendingAnsi).toBe('')
  })

  it('retains the last painted content if output ends with a lone CR', () => {
    const tail = ingestChunks(['last output\r', '', ''])
    expect(tail.partialLine).toBe('last output')
    expect(tail.pendingAnsi).toBe('\r')
    expect(tail.completeLines).toBe(0)
  })

  it.each([false, true])(
    'updates PTY and leaf transcripts when leaf diverged=%s',
    async (diverged) => {
      const ptyId = `pty-crlf-${diverged}`
      const { runtime, leaf } = runtimeWithLeaf(ptyId)
      if (diverged) {
        leaf.tailBuffer = ['leaf history']
        leaf.tailLinesTotal = 1
      }
      try {
        runtime.onPtyData(ptyId, 'QUJDRA==\r', 1)
        runtime.onPtyData(ptyId, '', 2)
        runtime.onPtyData(ptyId, '\n', 3)
        expect(readPtyTail(runtime, ptyId)).toEqual(['QUJDRA=='])
        expect(leaf.tailBuffer.at(-1)).toBe('QUJDRA==')
        expect(leaf.tailTranscriptBuffer).toEqual(['QUJDRA=='])
        expect(leaf.tailLinesTotal).toBe(diverged ? 2 : 1)
        expect(leaf.tailPendingAnsi).toBe('')
        expect(leaf.tailTruncated).toBe(false)
      } finally {
        await runtime.onPtyExit(ptyId, 0)
      }
    }
  )

  it('does not erase the final partial line on process exit', async () => {
    const ptyId = 'pty-crlf-exit'
    const { runtime, leaf } = runtimeWithLeaf(ptyId)
    runtime.onPtyData(ptyId, 'last output\r', 1)
    await runtime.onPtyExit(ptyId, 0)
    expect(leaf.tailPartialLine).toBe('last output')
    expect(leaf.tailLinesTotal).toBe(0)
  })
})
