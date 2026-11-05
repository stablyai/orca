import { describe, expect, it } from 'vitest'
import { normalizeTerminalChunk } from '../terminal-ansi-normalization'
import { appendNormalizedToTailBuffer } from './terminal-tail-buffer'

import { MAX_TAIL_PARTIAL_CHARS } from './terminal-tail-limits'
import {
  readPtyTail,
  runtimeWithLeaf
} from '../../../orca-runtime-tests/orca-runtime-pty-leaf.test-fixture'

describe('terminal tail CRLF chunk boundaries', () => {
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
