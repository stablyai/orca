import { describe, expect, it } from 'vitest'
import { decodeWorkerOutputCursor, encodeWorkerOutputCursor } from './worker-output-cursor'

describe('worker output cursors', () => {
  it('round-trips a source-pinned cursor without exposing source details', () => {
    const cursor = encodeWorkerOutputCursor('dispatch_1', 'transcript', 'source_digest', 42)

    expect(cursor).toMatch(/^owr1_/)
    expect(cursor).not.toContain('source_digest')
    expect(decodeWorkerOutputCursor(cursor, 'dispatch_1')).toEqual({
      source: 'transcript',
      sourceIdentity: 'source_digest',
      position: 42,
      legacy: false
    })
  })

  it('accepts legacy numeric terminal cursors', () => {
    expect(decodeWorkerOutputCursor(0, 'dispatch_1')).toEqual({
      source: 'terminal',
      sourceIdentity: null,
      position: 0,
      legacy: true
    })
    expect(decodeWorkerOutputCursor('17', 'dispatch_1')).toMatchObject({
      source: 'terminal',
      position: 17,
      legacy: true
    })
  })

  it('rejects another Dispatch and malformed cursor data', () => {
    const cursor = encodeWorkerOutputCursor('dispatch_1', 'terminal', 'terminal_digest', 1)

    expect(() => decodeWorkerOutputCursor(cursor, 'dispatch_2')).toThrow(
      expect.objectContaining({ code: 'cursor_dispatch_mismatch' })
    )
    expect(() => decodeWorkerOutputCursor('owr1_not-json', 'dispatch_1')).toThrow(
      expect.objectContaining({ code: 'cursor_invalid' })
    )
  })
})
