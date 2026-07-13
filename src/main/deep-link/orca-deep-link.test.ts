import { describe, expect, it } from 'vitest'
import { findOrcaUrlInArgv, parseOrcaDeepLink } from './orca-deep-link'

describe('parseOrcaDeepLink', () => {
  it('parses a focus link with a terminal handle', () => {
    expect(parseOrcaDeepLink('orca://focus?terminal=term_abc123')).toEqual({
      kind: 'focus',
      terminal: 'term_abc123',
      worktree: null
    })
  })

  it('parses a focus link with a worktree selector', () => {
    expect(parseOrcaDeepLink('orca://focus?worktree=id:repo123::/abs/path')).toEqual({
      kind: 'focus',
      terminal: null,
      worktree: 'id:repo123::/abs/path'
    })
  })

  it('keeps the terminal handle when both terminal and worktree are present', () => {
    const parsed = parseOrcaDeepLink('orca://focus?terminal=term_abc&worktree=id:wt')
    expect(parsed).toEqual({ kind: 'focus', terminal: 'term_abc', worktree: 'id:wt' })
  })

  it('parses a bare focus link with no target', () => {
    expect(parseOrcaDeepLink('orca://focus')).toEqual({
      kind: 'focus',
      terminal: null,
      worktree: null
    })
  })

  it('treats blank query params as absent', () => {
    expect(parseOrcaDeepLink('orca://focus?terminal=%20&worktree=')).toEqual({
      kind: 'focus',
      terminal: null,
      worktree: null
    })
  })

  it('decodes percent-encoded selectors', () => {
    expect(parseOrcaDeepLink('orca://focus?worktree=path%3A%2Ftmp%2Fwt')).toEqual({
      kind: 'focus',
      terminal: null,
      worktree: 'path:/tmp/wt'
    })
  })

  it('returns null for a different scheme', () => {
    expect(parseOrcaDeepLink('https://focus?terminal=term_abc')).toBeNull()
  })

  it('returns null for hosts without an OS route, including pair', () => {
    // Why: `orca://pair` is a paste-only pairing code, not an OS deep link.
    // Auto-applying runtime auth material from an untrusted link would be unsafe.
    expect(parseOrcaDeepLink('orca://pair?code=abc')).toBeNull()
    expect(parseOrcaDeepLink('orca://unknown?terminal=term_abc')).toBeNull()
  })

  it('does not partial-match the focus host', () => {
    expect(parseOrcaDeepLink('orca://focus-extra?terminal=term_abc')).toBeNull()
    expect(parseOrcaDeepLink('orca://focusing?terminal=term_abc')).toBeNull()
  })

  it('returns null for a malformed URL', () => {
    expect(parseOrcaDeepLink('not a url')).toBeNull()
    expect(parseOrcaDeepLink('')).toBeNull()
  })
})

describe('findOrcaUrlInArgv', () => {
  it('finds the orca url among launch args', () => {
    const argv = ['/path/to/Orca', '--flag', 'orca://focus?terminal=term_abc']
    expect(findOrcaUrlInArgv(argv)).toBe('orca://focus?terminal=term_abc')
  })

  it('matches the scheme case-insensitively', () => {
    expect(findOrcaUrlInArgv(['Orca', 'ORCA://focus?terminal=term_abc'])).toBe(
      'ORCA://focus?terminal=term_abc'
    )
  })

  it('surfaces any orca url so the app still comes forward', () => {
    expect(findOrcaUrlInArgv(['Orca', 'orca://pair?code=abc'])).toBe('orca://pair?code=abc')
  })

  it('returns null when no orca url is present', () => {
    expect(findOrcaUrlInArgv(['/path/to/Orca', '--serve', '/some/path'])).toBeNull()
    expect(findOrcaUrlInArgv([])).toBeNull()
  })
})
