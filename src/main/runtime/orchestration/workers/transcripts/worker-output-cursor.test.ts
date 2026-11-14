import { describe, expect, it } from 'vitest'
import { decodeWorkerOutputCursor, encodeWorkerOutputCursor } from './worker-output-cursor'

describe('worker output cursors', () => {
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
