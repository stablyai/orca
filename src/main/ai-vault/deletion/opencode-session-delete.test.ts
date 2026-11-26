import { describe, expect, it } from 'vitest'
import { resolveOpenCodeSessionRow } from './opencode-session-delete'

describe('resolveOpenCodeSessionRow', () => {
  it('accepts the scanned row shape of a database path plus a session id', () => {
    expect(resolveOpenCodeSessionRow('/data/opencode/opencode.db', 'ses_a')).toEqual({
      dbPath: '/data/opencode/opencode.db',
      sessionId: 'ses_a'
    })
  })

  it('accepts the legacy synthetic db#session path', () => {
    expect(resolveOpenCodeSessionRow('/data/opencode/opencode.db#ses_a', undefined)).toEqual({
      dbPath: '/data/opencode/opencode.db',
      sessionId: 'ses_a'
    })
  })

  it('preserves hashes in the database path and accepts other store names', () => {
    expect(
      resolveOpenCodeSessionRow('/home/a#b/.local/share/opencode/opencode.db', 'ses_a')
    ).toEqual({ dbPath: '/home/a#b/.local/share/opencode/opencode.db', sessionId: 'ses_a' })
    expect(resolveOpenCodeSessionRow('/data/history.db', 'ses_a')).toEqual({
      dbPath: '/data/history.db',
      sessionId: 'ses_a'
    })
  })

  it('rejects a mismatched synthetic id or a missing id', () => {
    expect(resolveOpenCodeSessionRow('/data/opencode/opencode.db#ses_a', 'ses_b')).toBeNull()
    expect(resolveOpenCodeSessionRow('/data/opencode/opencode.db', undefined)).toBeNull()
  })
})
