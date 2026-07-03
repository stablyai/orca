import { describe, expect, it } from 'vitest'
import {
  buildOpenCodeSqliteCandidatePath,
  looksLikeOpenCodeSqliteCandidate,
  splitOpenCodeSqliteCandidate
} from './session-scanner-opencode-sqlite-paths'

describe('splitOpenCodeSqliteCandidate', () => {
  it('splits a synthetic db#sessionId path', () => {
    const result = splitOpenCodeSqliteCandidate('/data/opencode.db#ses_abc')
    expect(result).toEqual({ dbPath: '/data/opencode.db', sessionId: 'ses_abc' })
  })

  it('splits a stable-db path', () => {
    const result = splitOpenCodeSqliteCandidate('/data/opencode-stable.db#ses_xyz')
    expect(result).toEqual({ dbPath: '/data/opencode-stable.db', sessionId: 'ses_xyz' })
  })

  it('rejects a path whose db basename is not opencode*.db', () => {
    expect(splitOpenCodeSqliteCandidate('/data/random.db#ses_abc')).toBeNull()
    expect(splitOpenCodeSqliteCandidate('/data/notes.txt#ses_abc')).toBeNull()
  })

  it('rejects a path without a separator', () => {
    expect(splitOpenCodeSqliteCandidate('/data/opencode.db')).toBeNull()
  })

  it('rejects an empty sessionId', () => {
    expect(splitOpenCodeSqliteCandidate('/data/opencode.db#')).toBeNull()
  })
})

describe('looksLikeOpenCodeSqliteCandidate', () => {
  it('returns true for a synthetic path', () => {
    expect(looksLikeOpenCodeSqliteCandidate('/x/opencode.db#ses_1')).toBe(true)
  })

  it('returns false for a real filesystem path', () => {
    expect(looksLikeOpenCodeSqliteCandidate('/x/storage/session/proj/ses_1.json')).toBe(false)
  })
})

describe('buildOpenCodeSqliteCandidatePath', () => {
  it('joins dbPath and sessionId with #', () => {
    expect(buildOpenCodeSqliteCandidatePath('/d/opencode.db', 'ses_1')).toBe('/d/opencode.db#ses_1')
  })
})
