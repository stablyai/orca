import { describe, expect, it } from 'vitest'
import { resolveOpenCodeSessionRow } from './opencode-session-delete'

describe('resolveOpenCodeSessionRow', () => {
  it('accepts the scanned row shape of a database path plus a session id', () => {
    expect(resolveOpenCodeSessionRow('/data/opencode/opencode.db', 'ses_a', 'opencode2')).toEqual({
      dbPath: '/data/opencode/opencode.db',
      sessionId: 'ses_a'
    })
  })

  it('accepts the legacy synthetic db#session path', () => {
    expect(
      resolveOpenCodeSessionRow('/data/opencode/opencode.db#ses_a', undefined, 'opencode2')
    ).toEqual({ dbPath: '/data/opencode/opencode.db', sessionId: 'ses_a' })
  })

  it('rejects mismatched, missing, or non-database identities', () => {
    expect(
      resolveOpenCodeSessionRow('/data/opencode/opencode.db#ses_a', 'ses_b', 'opencode2')
    ).toBeNull()
    expect(
      resolveOpenCodeSessionRow('/data/opencode/opencode.db', undefined, 'opencode2')
    ).toBeNull()
    expect(resolveOpenCodeSessionRow('/data/notes.txt', 'ses_a', 'opencode2')).toBeNull()
  })
})
