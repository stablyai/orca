import { describe, expect, it } from 'vitest'
import { parseBlamePorcelain, parseFileBlamePorcelain } from './line-blame'

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

  it('returns null when the first token is not a valid object id', () => {
    expect(parseBlamePorcelain('not-a-sha here\nauthor X')).toBeNull()
    // 39, 41, and 63 hex: none is a valid object-id length.
    expect(parseBlamePorcelain(`${'a'.repeat(39)} 1 1 1\nauthor X`)).toBeNull()
    expect(parseBlamePorcelain(`${'a'.repeat(41)} 1 1 1\nauthor X`)).toBeNull()
    expect(parseBlamePorcelain(`${'a'.repeat(63)} 1 1 1\nauthor X`)).toBeNull()
  })

  // Why: a SHA-256 repository (`git init --object-format=sha256`) reports 64-hex
  // object ids. Rejecting those left both blame surfaces silently empty.
  it('parses a 64-hex object id from a SHA-256 repository', () => {
    const result = parseBlamePorcelain(SHA256_LINE)
    expect(result?.sha).toBe(SHA256)
    expect(result?.author).toBe('Ada')
    expect(result?.isUncommitted).toBe(false)
  })

  it('flags an all-zero 64-hex sha as uncommitted', () => {
    const result = parseBlamePorcelain(SHA256_LINE.replace(SHA256, '0'.repeat(64)))
    expect(result?.isUncommitted).toBe(true)
  })
})

const SHA = 'a'.repeat(40)
const ZERO = '0'.repeat(40)
const SHA256 = 'b'.repeat(64)
const SHA256_LINE = [
  `${SHA256} 5 3 1`,
  'author Ada',
  'author-time 1777664339',
  'summary feat: add a thing',
  'filename src/index.ts',
  '\tconst x = 1'
].join('\n')

describe('parseFileBlamePorcelain', () => {
  it('does not treat tab-prefixed content that looks like a header as a header', () => {
    const out = parseFileBlamePorcelain(
      [
        `${SHA} 1 1 1`,
        'author Neil',
        'author-time 1700000000',
        'summary real',
        'filename f.txt',
        `\t${'b'.repeat(40)} 9 9 9`,
        `${SHA} 2 2`,
        '\tauthor Impostor'
      ].join('\n')
    )
    expect(Object.keys(out).sort()).toEqual(['1', '2'])
    expect(out[1].author).toBe('Neil')
    expect(out[2].author).toBe('Neil')
  })

  it('handles CRLF and a missing trailing newline', () => {
    const out = parseFileBlamePorcelain(
      [`${SHA} 1 1 1`, 'author Ada', 'author-time 1700000000', 'summary s', '\tcode()'].join('\r\n')
    )
    expect(out[1].author).toBe('Ada')
    expect(out[1].summary).toBe('s')
  })

  it('returns nothing for empty output', () => {
    expect(parseFileBlamePorcelain('')).toEqual({})
  })

  it('flags the all-zero sha as uncommitted', () => {
    const out = parseFileBlamePorcelain(
      [
        `${ZERO} 3 3 1`,
        'author Not Committed Yet',
        'author-time 1700000000',
        'summary x',
        '\tnew'
      ].join('\n')
    )
    expect(out[3].isUncommitted).toBe(true)
  })

  it('carries commit metadata forward to later lines of the same commit', () => {
    const out = parseFileBlamePorcelain(
      [
        `${SHA} 1 1 1`,
        'author Neil',
        'author-time 1700000000',
        'summary first',
        '\tone',
        `${SHA} 2 2 1`,
        '\ttwo'
      ].join('\n')
    )
    expect(out[2].author).toBe('Neil')
    expect(out[2].summary).toBe('first')
    expect(out[2].authorTimeMs).toBe(1700000000000)
  })

  it('keeps a boundary commit line attributed', () => {
    const out = parseFileBlamePorcelain(
      [
        `${SHA} 1 1 1`,
        'author Root',
        'author-time 1700000000',
        'summary init',
        'boundary',
        '\tfirst'
      ].join('\n')
    )
    expect(out[1].author).toBe('Root')
  })

  // Why: a SHA-256 repository reports 64-hex object ids. Rejecting those made the
  // whole-file read return nothing, which also silently disabled the per-line
  // fallback's cache, so no authorship appeared anywhere.
  it('parses 64-hex object ids from a SHA-256 repository, including carry-forward', () => {
    const out = parseFileBlamePorcelain(
      [
        `${SHA256} 1 1 1`,
        'author Ada',
        'author-time 1700000000',
        'summary first',
        '\tone',
        `${SHA256} 2 2 1`,
        '\ttwo'
      ].join('\n')
    )
    expect(out[1].sha).toBe(SHA256)
    expect(out[1].author).toBe('Ada')
    expect(out[1].isUncommitted).toBe(false)
    expect(out[2].author).toBe('Ada')
    expect(out[2].summary).toBe('first')
  })

  it('flags an all-zero 64-hex sha as uncommitted', () => {
    const out = parseFileBlamePorcelain(
      [
        `${'0'.repeat(64)} 3 3 1`,
        'author Not Committed Yet',
        'author-time 1700000000',
        'summary x',
        '\tnew'
      ].join('\n')
    )
    expect(out[3].isUncommitted).toBe(true)
  })
})
