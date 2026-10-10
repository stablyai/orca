import { describe, expect, it } from 'vitest'
import { decodeRunListCursor, encodeRunListCursor } from './run-list-cursor'
import type { RunRow } from '../types'

describe('run-list-cursor', () => {
  it('round-trips createdAt and id', () => {
    const run = { created_at: '2026-01-02 03:04:05', id: 'run_abc' } as RunRow
    expect(decodeRunListCursor(encodeRunListCursor(run))).toEqual({
      createdAt: '2026-01-02 03:04:05',
      id: 'run_abc'
    })
  })

  it('rejects an invalid cursor with cursor_invalid', () => {
    expect(() => decodeRunListCursor('not-a-cursor')).toThrow(/cursor is invalid/)
  })
})
