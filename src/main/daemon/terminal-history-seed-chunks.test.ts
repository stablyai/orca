import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  iterateTerminalHistorySeedChunks,
  measureTerminalHistorySeed,
  TERMINAL_HISTORY_SEED_CHUNK_CODE_UNITS
} from './terminal-history-seed-chunks'

describe('terminal history seed chunks', () => {
  it('preserves segment order without splitting valid surrogate pairs', () => {
    const segments = [
      `${'a'.repeat(TERMINAL_HISTORY_SEED_CHUNK_CODE_UNITS - 1)}\ud83d`,
      '\ude00tail'
    ]
    const chunks = [...iterateTerminalHistorySeedChunks(segments)]

    expect(chunks.join('')).toBe(segments.join(''))
    expect(chunks.every((chunk) => chunk.length <= TERMINAL_HISTORY_SEED_CHUNK_CODE_UNITS)).toBe(
      true
    )
    expect(chunks).toContain('😀')
  })

  it('measures the exact chunk count, code units, and UTF-16 digest', () => {
    const segments = ['alpha', '😀', '\x1b[31mred']
    const metrics = measureTerminalHistorySeed(segments)
    const expectedDigest = createHash('sha256')
      .update(Buffer.from(segments.join(''), 'utf16le'))
      .digest('hex')

    expect(metrics).toEqual({
      chunkCount: [...iterateTerminalHistorySeedChunks(segments)].length,
      codeUnits: segments.join('').length,
      sha256: expectedDigest
    })
  })
})
