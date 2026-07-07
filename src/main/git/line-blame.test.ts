import { describe, expect, it } from 'vitest'
import { parseBlamePorcelain } from './line-blame'

const COMMITTED = [
  '8d56823998be158e57a250a4a88928d312dcfadd 5 3 1',
  'author Neil',
  'author-mail <4138956+nwparker@users.noreply.github.com>',
  'author-time 1777664339',
  'author-tz -0700',
  'committer GitHub',
  'committer-mail <noreply@github.com>',
  'committer-time 1777664339',
  'summary docs: localize README install updates (#1319)',
  'previous 22b80f8ce5fdaee307545d21fb5ad5a3be5e5782 README.md',
  'filename README.md',
  '\tsome source line'
].join('\n')

const UNCOMMITTED = [
  '0000000000000000000000000000000000000000 1 1 1',
  'author Not Committed Yet',
  'author-mail <not.committed.yet>',
  'author-time 1777664999',
  'summary Version of index.ts from index.ts',
  'filename src/index.ts',
  '\tconst x = 1'
].join('\n')

describe('parseBlamePorcelain', () => {
  it('parses a committed line into structured authorship', () => {
    expect(parseBlamePorcelain(COMMITTED)).toEqual({
      sha: '8d56823998be158e57a250a4a88928d312dcfadd',
      author: 'Neil',
      authorTimeMs: 1777664339000,
      summary: 'docs: localize README install updates (#1319)',
      isUncommitted: false
    })
  })

  it('yields NaN authorTimeMs (not 1970) when the author-time header is absent', () => {
    const noTime = [
      '8d56823998be158e57a250a4a88928d312dcfadd 5 3 1',
      'author Neil',
      'summary no author-time here',
      '\tsource'
    ].join('\n')
    expect(parseBlamePorcelain(noTime)?.authorTimeMs).toBeNaN()
  })

  it('strips CRLF so author/summary carry no trailing carriage return', () => {
    const crlf = COMMITTED.split('\n').join('\r\n')
    const result = parseBlamePorcelain(crlf)
    expect(result?.author).toBe('Neil')
    expect(result?.summary).toBe('docs: localize README install updates (#1319)')
  })

  it('flags the all-zero sha as uncommitted', () => {
    const result = parseBlamePorcelain(UNCOMMITTED)
    expect(result?.isUncommitted).toBe(true)
    expect(result?.author).toBe('Not Committed Yet')
  })

  it('returns null for empty output', () => {
    expect(parseBlamePorcelain('')).toBeNull()
    expect(parseBlamePorcelain('   \n')).toBeNull()
  })

  it('returns null when the first token is not a 40-char sha', () => {
    expect(parseBlamePorcelain('not-a-sha here\nauthor X')).toBeNull()
  })
})
