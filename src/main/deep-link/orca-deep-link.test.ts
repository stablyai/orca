import { describe, expect, it } from 'vitest'
import { focusDeepLinkFromArguments, parseOrcaDeepLink } from './orca-deep-link'

describe('parseOrcaDeepLink', () => {
  it('parses a focus link with a terminal handle in the query', () => {
    expect(parseOrcaDeepLink('orca://focus?terminal=term_abc123')).toEqual({
      kind: 'focus',
      terminal: 'term_abc123',
      worktree: null
    })
  })

  it('parses a focus link with a terminal handle in the path', () => {
    expect(parseOrcaDeepLink('orca://focus/term_abc123')).toEqual({
      kind: 'focus',
      terminal: 'term_abc123',
      worktree: null
    })
  })

  it('keeps the handle case-sensitive in both spellings', () => {
    expect(parseOrcaDeepLink('orca://focus/term_AbC')?.terminal).toBe('term_AbC')
    expect(parseOrcaDeepLink('ORCA://focus?terminal=term_AbC')?.terminal).toBe('term_AbC')
  })

  it('routes on the exact lowercase host', () => {
    expect(parseOrcaDeepLink('orca://FOCUS/term_abc')).toBeNull()
  })

  it('parses a focus link with a worktree selector', () => {
    expect(parseOrcaDeepLink('orca://focus?worktree=id:repo123::/abs/path')).toEqual({
      kind: 'focus',
      terminal: null,
      worktree: 'id:repo123::/abs/path'
    })
  })

  it('keeps the terminal handle when both terminal and worktree are present', () => {
    expect(parseOrcaDeepLink('orca://focus?terminal=term_abc&worktree=id:wt')).toEqual({
      kind: 'focus',
      terminal: 'term_abc',
      worktree: 'id:wt'
    })
  })

  it('lets a path handle win over a query handle', () => {
    expect(parseOrcaDeepLink('orca://focus/term_path?terminal=term_query')?.terminal).toBe(
      'term_path'
    )
  })

  it('parses a bare focus link with no target', () => {
    expect(parseOrcaDeepLink('orca://focus')).toEqual({
      kind: 'focus',
      terminal: null,
      worktree: null
    })
    expect(parseOrcaDeepLink('orca://focus/')).toEqual({
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

  it('decodes percent-encoded selectors and handles', () => {
    expect(parseOrcaDeepLink('orca://focus?worktree=path%3A%2Ftmp%2Fwt')?.worktree).toBe(
      'path:/tmp/wt'
    )
    expect(parseOrcaDeepLink('orca://focus/term%5Fabc')?.terminal).toBe('term_abc')
  })

  it('rejects a handle outside the runtime alphabet', () => {
    expect(parseOrcaDeepLink('orca://focus?terminal=term%20abc')).toBeNull()
    expect(parseOrcaDeepLink('orca://focus/term/abc')).toBeNull()
    expect(parseOrcaDeepLink('orca://focus/%E0%A4%A')).toBeNull()
    expect(parseOrcaDeepLink(`orca://focus/${'a'.repeat(129)}`)).toBeNull()
  })

  it('rejects an oversized worktree selector', () => {
    expect(parseOrcaDeepLink(`orca://focus?worktree=${'x'.repeat(1025)}`)).toBeNull()
    expect(parseOrcaDeepLink(`orca://focus?worktree=${'x'.repeat(1024)}`)).not.toBeNull()
  })

  it('returns null for a different scheme', () => {
    expect(parseOrcaDeepLink('https://focus?terminal=term_abc')).toBeNull()
  })

  it('returns null for hosts without an OS route, including pair and skill share', () => {
    // Why: `orca://pair` is a paste-only pairing code. Auto-applying runtime auth
    // material from an untrusted link would be unsafe. Skill-share links have their own router.
    expect(parseOrcaDeepLink('orca://pair?code=abc')).toBeNull()
    expect(parseOrcaDeepLink('orca://skills/share/share_abc')).toBeNull()
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

describe('focusDeepLinkFromArguments', () => {
  it('finds and parses the focus link among launch args', () => {
    const argv = ['/path/to/Orca', '--flag', 'orca://focus?terminal=term_abc']
    expect(focusDeepLinkFromArguments(argv)).toEqual({
      kind: 'focus',
      terminal: 'term_abc',
      worktree: null
    })
  })

  it('matches the scheme case-insensitively', () => {
    expect(focusDeepLinkFromArguments(['Orca', 'ORCA://focus/term_abc'])?.terminal).toBe('term_abc')
  })

  it('skips other orca links so they stay with their own routers', () => {
    expect(
      focusDeepLinkFromArguments(['Orca', 'orca://pair?code=abc', 'orca://skills/share/s_1'])
    ).toBeNull()
    expect(
      focusDeepLinkFromArguments(['Orca', 'orca://skills/share/s_1', 'orca://focus/term_abc'])
        ?.terminal
    ).toBe('term_abc')
  })

  it('returns null when no focus link is present', () => {
    expect(focusDeepLinkFromArguments(['/path/to/Orca', '--serve', '/some/path'])).toBeNull()
    expect(focusDeepLinkFromArguments([])).toBeNull()
  })
})
