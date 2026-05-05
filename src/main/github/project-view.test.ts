// Why: covers the recent fixes —
// (a) network errors must NOT be misclassified as not_found ("could not
//     resolve host" partially overlaps "could not resolve to a"),
// (b) repo slug validation must accept names with leading underscore
//     (GitHub allows them, e.g. `_internal`),
// (c) owner slug validation must reject `.`/`_` (GitHub disallows them in
//     usernames/orgs),
// (d) parseProjectPaste shorthand owner-only alphabet matches the renderer.
import { describe, expect, it } from 'vitest'
import {
  classifyProjectError,
  isValidOwnerSlug,
  isValidRepoSlug,
  parseProjectPaste
} from './project-view'

describe('classifyProjectError', () => {
  it('classifies HTTP 404 as not_found', () => {
    expect(classifyProjectError('HTTP 404 Not Found', '').type).toBe('not_found')
  })

  it('classifies "Could not resolve to a User" as not_found', () => {
    expect(
      classifyProjectError('Could not resolve to a User with the login of foo', '').type
    ).toBe('not_found')
  })

  it('classifies "could not resolve host" as network_error, NOT not_found', () => {
    // Why: this was the bug — substring "could not resolve" overlaps. The
    // network branch must run before not_found, and the not_found check
    // must require "to a " to disambiguate.
    expect(classifyProjectError('could not resolve host: api.github.com', '').type).toBe(
      'network_error'
    )
  })

  it('classifies "dial tcp" timeouts as network_error', () => {
    expect(classifyProjectError('dial tcp 140.82.112.3:443: i/o timeout', '').type).toBe(
      'network_error'
    )
  })

  it('classifies rate-limit text as rate_limited', () => {
    expect(classifyProjectError('API rate limit exceeded for user', '').type).toBe('rate_limited')
  })

  it('classifies missing-scope as scope_missing', () => {
    expect(
      classifyProjectError('your token has not been granted the required scopes', '').type
    ).toBe('scope_missing')
  })

  it('classifies auth-required when gh is not signed in', () => {
    expect(classifyProjectError('gh auth login required', '').type).toBe('auth_required')
  })
})

describe('isValidOwnerSlug', () => {
  it('accepts plain alphanumerics and hyphens', () => {
    expect(isValidOwnerSlug('acme')).toBe(true)
    expect(isValidOwnerSlug('acme-co')).toBe(true)
    expect(isValidOwnerSlug('user1')).toBe(true)
  })

  it('rejects underscore (GitHub disallows it in usernames/orgs)', () => {
    expect(isValidOwnerSlug('_acme')).toBe(false)
    expect(isValidOwnerSlug('acme_co')).toBe(false)
  })

  it('rejects leading hyphen and dot', () => {
    expect(isValidOwnerSlug('-acme')).toBe(false)
    expect(isValidOwnerSlug('.acme')).toBe(false)
  })

  it('rejects empty and slash-containing values', () => {
    expect(isValidOwnerSlug('')).toBe(false)
    expect(isValidOwnerSlug('a/b')).toBe(false)
    expect(isValidOwnerSlug(123)).toBe(false)
  })
})

describe('isValidRepoSlug', () => {
  it('accepts leading underscore (GitHub allows it for repo names)', () => {
    expect(isValidRepoSlug('_internal')).toBe(true)
  })

  it('accepts leading dot', () => {
    expect(isValidRepoSlug('.github')).toBe(true)
  })

  it('accepts dots, dashes, underscores anywhere', () => {
    expect(isValidRepoSlug('repo-name')).toBe(true)
    expect(isValidRepoSlug('repo.name')).toBe(true)
    expect(isValidRepoSlug('repo_name')).toBe(true)
  })

  it('rejects reserved single/double dot', () => {
    expect(isValidRepoSlug('.')).toBe(false)
    expect(isValidRepoSlug('..')).toBe(false)
  })

  it('rejects path separators and empty', () => {
    expect(isValidRepoSlug('a/b')).toBe(false)
    expect(isValidRepoSlug('')).toBe(false)
  })
})

describe('parseProjectPaste', () => {
  it('parses owner/number shorthand', () => {
    expect(parseProjectPaste('acme/42')).toEqual({ kind: 'bare', owner: 'acme', number: 42 })
  })

  it('rejects shorthand with underscore in owner (renderer parity)', () => {
    // Why: the renderer's parser uses `[A-Za-z0-9][A-Za-z0-9-]*` for owner
    // (matches OWNER_SLUG_RE). Both sides must reject the same inputs.
    expect(parseProjectPaste('co_op/45')).toBeNull()
  })

  it('parses org URL with view number', () => {
    expect(
      parseProjectPaste('https://github.com/orgs/acme/projects/42/views/3')
    ).toEqual({ kind: 'org', owner: 'acme', number: 42, viewNumber: 3 })
  })

  it('parses user URL', () => {
    expect(parseProjectPaste('https://github.com/users/octocat/projects/1')).toEqual({
      kind: 'user',
      owner: 'octocat',
      number: 1
    })
  })

  it('rejects URLs whose owner has invalid characters', () => {
    expect(parseProjectPaste('https://github.com/orgs/co_op/projects/1')).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(parseProjectPaste('')).toBeNull()
    expect(parseProjectPaste('   ')).toBeNull()
  })
})
