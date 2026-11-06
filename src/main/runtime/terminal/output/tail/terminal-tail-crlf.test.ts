import { describe, expect, it } from 'vitest'
import { normalizeTerminalChunk } from '../terminal-ansi-normalization'
import { appendNormalizedToTailBuffer } from './terminal-tail-buffer'
import {
  buildRestoredTerminalTailSeed,
  MAX_RESTORE_TAIL_SEED_CHARS
} from './terminal-tail-restore-seed'

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

  it('ends lines at CR CR LF, the sequence raw-mode programs emit', async () => {
    const ptyId = 'pty-cr-cr-lf'
    const { runtime, leaf } = runtimeWithLeaf(ptyId)
    try {
      runtime.onPtyData(ptyId, 'first\r\r\nsecond\r\x1b[0m\r\nthird\r', 1)
      runtime.onPtyData(ptyId, '\r', 2)
      runtime.onPtyData(ptyId, '\n', 3)
      runtime.onPtyData(ptyId, 'fourth\r', 4)
      runtime.onPtyData(ptyId, '\x1b[0m', 5)
      runtime.onPtyData(ptyId, '\r\n', 6)
      const lines = ['first', 'second', 'third', 'fourth']
      expect(readPtyTail(runtime, ptyId)).toEqual(lines)
      expect(leaf.tailTranscriptBuffer).toEqual(lines)
      expect(leaf.tailPendingAnsi).toBe('')
    } finally {
      await runtime.onPtyExit(ptyId, 0)
    }
  })

  it('restores without a blank first row when the cut lands before CR CR LF', () => {
    // The kept suffix starts exactly at CR CR LF.
    const lineCount = Math.floor((MAX_RESTORE_TAIL_SEED_CHARS - 3) / 5)
    const filler = 'x'.repeat(MAX_RESTORE_TAIL_SEED_CHARS - 3 - lineCount * 5)
    const suffix = `\r\r\n${filler}${'line\n'.repeat(lineCount)}`
    expect(suffix).toHaveLength(MAX_RESTORE_TAIL_SEED_CHARS)
    const seed = buildRestoredTerminalTailSeed(`earlier output${suffix}`)
    expect(seed?.linesTotal).toBe(lineCount)
  })

  it('does not erase the final partial line on process exit', async () => {
    const ptyId = 'pty-crlf-exit'
    const { runtime, leaf } = runtimeWithLeaf(ptyId)
    runtime.onPtyData(ptyId, 'last output\r', 1)
    await runtime.onPtyExit(ptyId, 0)
    expect(leaf.tailPartialLine).toBe('last output')
    expect(leaf.tailLinesTotal).toBe(0)
  })
})
