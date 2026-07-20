// Why: covers the recent fixes —
// (a) network errors must NOT be misclassified as not_found ("could not
//     resolve host" partially overlaps "could not resolve to a"),
// (b) repo slug validation must accept names with leading underscore
//     (GitHub allows them, e.g. `_internal`),
// (c) owner slug validation must reject `.`/`_` (GitHub disallows them in
//     usernames/orgs),
// (d) parseProjectPaste shorthand owner-only alphabet matches the renderer,
// (e) project owner/capability caches stay bounded in long sessions.
// Plus Phase 1b: normalizeItem hydrates row.content.subIssuesSummary /
// trackedIssues / trackedInIssues from the linked Issue, and the new
// 'issue-ref-list' union variant is a forward-compat stub that falls through
// to the existing default: return null branch in normalizeFieldValue.
import { beforeEach, describe, expect, it } from 'vitest'
import {
  GITHUB_PROJECT_REF_INPUT_MAX_BYTES,
  GITHUB_PROJECT_REF_INPUT_TOO_LARGE_ERROR
} from '../../shared/github-project-ref-input'
import {
  PROJECT_VIEW_OWNER_CACHE_MAX_ENTRIES,
  _getProjectViewCacheSizesForTests,
  _getProjectViewOwnerTypeForTests,
  _hasProjectViewParentFieldRetriedForTests,
  _hasProjectViewParentFieldWarningLoggedForTests,
  _markProjectViewParentFieldRetriedForTests,
  _markProjectViewParentFieldWarningLoggedForTests,
  _rememberProjectViewOwnerTypeForTests,
  _resetProjectViewCachesForTests,
  classifyProjectError,
  isValidOwnerSlug,
  isValidRepoSlug,
  normalizeFieldValue,
  normalizeItem,
  parseProjectPaste,
  resolveProjectRef,
  FIELD_CONFIG_FRAGMENT,
  FIELD_VALUES_SELECTION,
  itemContentSelection,
  type RawFieldValue,
  type RawItem
} from './project-view'

describe('classifyProjectError', () => {
  it('classifies HTTP 404 as not_found', () => {
    expect(classifyProjectError('HTTP 404 Not Found', '').type).toBe('not_found')
  })

  it('classifies "Could not resolve to a User" as not_found', () => {
    expect(classifyProjectError('Could not resolve to a User with the login of foo', '').type).toBe(
      'not_found'
    )
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
    expect(parseProjectPaste('https://github.com/orgs/acme/projects/42/views/3')).toEqual({
      kind: 'org',
      owner: 'acme',
      number: 42,
      viewNumber: 3
    })
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

  it('rejects oversized valid-looking URLs without parsing the secret-bearing tail', () => {
    const secret = 'project-url-secret'
    const input = [
      'https://github.com/orgs/acme/projects/42?',
      secret,
      'x'.repeat(GITHUB_PROJECT_REF_INPUT_MAX_BYTES)
    ].join('')

    expect(parseProjectPaste(input)).toBeNull()
  })
})

describe('resolveProjectRef', () => {
  it('rejects oversized project refs with a metadata-only validation error', async () => {
    const secret = 'project-url-secret'
    const input = [
      'https://github.com/orgs/acme/projects/42?',
      secret,
      'x'.repeat(GITHUB_PROJECT_REF_INPUT_MAX_BYTES)
    ].join('')

    await expect(resolveProjectRef({ input })).resolves.toEqual({
      ok: false,
      error: {
        type: 'validation_error',
        message: GITHUB_PROJECT_REF_INPUT_TOO_LARGE_ERROR
      }
    })
    await expect(resolveProjectRef({ input })).resolves.not.toMatchObject({
      error: { message: expect.stringContaining(secret) }
    })
  })
})

describe('project view owner caches', () => {
  beforeEach(() => {
    _resetProjectViewCachesForTests()
  })

  it('LRU-evicts old owner type probes', () => {
    for (let i = 0; i <= PROJECT_VIEW_OWNER_CACHE_MAX_ENTRIES; i++) {
      _rememberProjectViewOwnerTypeForTests(`owner-${i}`, i % 2 === 0 ? 'organization' : 'user')
    }

    expect(_getProjectViewCacheSizesForTests().ownerTypes).toBe(
      PROJECT_VIEW_OWNER_CACHE_MAX_ENTRIES
    )
    expect(_getProjectViewOwnerTypeForTests('owner-0')).toBeUndefined()
    expect(_getProjectViewOwnerTypeForTests('owner-1')).toBe('user')
  })

  it('LRU-evicts old parent-field retry and warning probes', () => {
    for (let i = 0; i <= PROJECT_VIEW_OWNER_CACHE_MAX_ENTRIES; i++) {
      const scopeKey = `owner-${i}\u0000organization`
      _markProjectViewParentFieldRetriedForTests(scopeKey)
      _markProjectViewParentFieldWarningLoggedForTests(scopeKey)
    }

    expect(_getProjectViewCacheSizesForTests()).toMatchObject({
      parentFieldRetries: PROJECT_VIEW_OWNER_CACHE_MAX_ENTRIES,
      parentFieldWarnings: PROJECT_VIEW_OWNER_CACHE_MAX_ENTRIES
    })
    expect(_hasProjectViewParentFieldRetriedForTests('owner-0\u0000organization')).toBe(false)
    expect(_hasProjectViewParentFieldWarningLoggedForTests('owner-0\u0000organization')).toBe(false)
    expect(_hasProjectViewParentFieldRetriedForTests('owner-1\u0000organization')).toBe(true)
    expect(_hasProjectViewParentFieldWarningLoggedForTests('owner-1\u0000organization')).toBe(true)
  })
})

// Why: Phase 1b — sub-issue progress, tracked issues, and tracked-by issues
// live on the linked Issue (Issue.subIssuesSummary / .trackedIssues /
// .trackedInIssues), not on the ProjectV2 field-value union. The renderer
// reads from row.content.* for these three columns. normalizeItem must
// hydrate them defensively, preserving the empty-but-valid shape (vs null)
// so the cell can distinguish "field exists with no value" from "field
// was dropped".
//
// Test inputs are typed via the named types RawItem / RawFieldValue
// (imported from project-view) cast through `unknown` at the test boundary —
// the local RawContent shape is intentionally flexible (all fields optional)
// so the test can construct only the fields it needs while the cast
// documents which production type each input satisfies.
describe('normalizeItem', () => {
  function makeIssueItem(contentExtras: Record<string, unknown>): RawItem {
    // Why: the production RawContent permits __typename / id / number / etc.
    // The test only needs to vary the hierarchy fields; spread into a
    // structurally-conforming object and cast at the boundary.
    return {
      id: 'item-1',
      type: 'ISSUE',
      content: { __typename: 'Issue', number: 1, title: 't', ...contentExtras },
      fieldValues: { nodes: [] }
    } as unknown as RawItem
  }

  it('hydrates subIssuesSummary from Issue.subIssuesSummary', () => {
    const raw = makeIssueItem({
      subIssuesSummary: { total: 7, completed: 3, percentCompleted: 43 }
    })
    const out = normalizeItem(raw, 0)
    expect(out.ok).toBe(true)
    if (!out.ok) {
      return
    }
    expect(out.row.content.subIssuesSummary).toEqual({
      total: 7,
      completed: 3,
      percentCompleted: 43
    })
  })

  it('preserves subIssuesSummary as empty-but-valid when total is 0', () => {
    const raw = makeIssueItem({
      subIssuesSummary: { total: 0, completed: 0, percentCompleted: 0 }
    })
    const out = normalizeItem(raw, 0)
    expect(out.ok).toBe(true)
    if (!out.ok) {
      return
    }
    expect(out.row.content.subIssuesSummary).toEqual({
      total: 0,
      completed: 0,
      percentCompleted: 0
    })
  })

  it('nulls subIssuesSummary when the Issue omits it', () => {
    const raw = makeIssueItem({})
    const out = normalizeItem(raw, 0)
    expect(out.ok).toBe(true)
    if (!out.ok) {
      return
    }
    expect(out.row.content.subIssuesSummary).toBeNull()
  })

  it('hydrates trackedIssues from Issue.trackedIssues', () => {
    const raw = makeIssueItem({
      trackedIssues: {
        nodes: [
          { number: 1, title: 'a', url: 'https://github.com/acme/repo/issues/1' },
          { number: 2, title: 'b', url: 'https://github.com/acme/repo/issues/2' }
        ]
      }
    })
    const out = normalizeItem(raw, 0)
    expect(out.ok).toBe(true)
    if (!out.ok) {
      return
    }
    expect(out.row.content.trackedIssues).toHaveLength(2)
    expect(out.row.content.trackedIssues[0]).toEqual({
      number: 1,
      title: 'a',
      url: 'https://github.com/acme/repo/issues/1'
    })
    expect(out.row.content.trackedIssues[1]).toEqual({
      number: 2,
      title: 'b',
      url: 'https://github.com/acme/repo/issues/2'
    })
  })

  it('hydrates trackedInIssues from Issue.trackedInIssues', () => {
    const raw = makeIssueItem({
      trackedInIssues: {
        nodes: [{ number: 3, title: 'c', url: 'https://github.com/acme/repo/issues/3' }]
      }
    })
    const out = normalizeItem(raw, 0)
    expect(out.ok).toBe(true)
    if (!out.ok) {
      return
    }
    expect(out.row.content.trackedInIssues).toHaveLength(1)
    expect(out.row.content.trackedInIssues[0]).toEqual({
      number: 3,
      title: 'c',
      url: 'https://github.com/acme/repo/issues/3'
    })
  })

  it('drops trackedIssues sub-nodes that lack a number, keeps the well-formed ones', () => {
    const raw = makeIssueItem({
      trackedIssues: {
        nodes: [
          { number: 1, title: 'a', url: 'https://github.com/acme/repo/issues/1' },
          { title: 'malformed', url: 'https://github.com/acme/repo/issues/2' },
          { number: 3, title: 'c', url: 'https://github.com/acme/repo/issues/3' }
        ]
      }
    })
    const out = normalizeItem(raw, 0)
    expect(out.ok).toBe(true)
    if (!out.ok) {
      return
    }
    expect(out.row.content.trackedIssues).toHaveLength(2)
    expect(out.row.content.trackedIssues[0]?.number).toBe(1)
    expect(out.row.content.trackedIssues[1]?.number).toBe(3)
  })

  // Why: the new 'issue-ref-list' union variant is a defensive forward-compat
  // stub. No live GraphQL __typename currently maps to it (live __type
  // introspection on 2026-07-14 confirmed the ProjectV2ItemFieldValue union
  // has 12 members, none hierarchy-related). The normalizer's
  // default: return null branch handles unknown typenames; this test
  // locks that invariant for the future-typename case.
  it('normalizeFieldValue returns null for an unknown __typename (forward-compat)', () => {
    // Why: this is the contract that protects us from schema drift — when
    // GitHub adds a new ProjectV2ItemField*Value member, normalizeFieldValue
    // must silently drop it (return null) until we add an explicit case.
    // This test passes today because the existing default branch handles
    // the unknown typename; it is the regression guard.
    const out = normalizeFieldValue({
      __typename: 'ProjectV2ItemFieldSomeFutureValue',
      field: { id: 'F', name: 'future', dataType: 'TEXT' }
    } as unknown as RawFieldValue)
    expect(out).toBeNull()
  })
})

// Why: Bug 1 from the Phase 1b verification pass — a `//` (JS-style)
// comment sitting inside the itemContentSelection GraphQL template literal
// parsed fine in TypeScript but is invalid GraphQL syntax (only `#`
// comments are supported), so every real fetch for a project with Issue
// items failed with "Expected NAME, actual: UNKNOWN_CHAR" and looked
// exactly like a permissions problem. normalizeItem's tests never caught
// this because they feed hand-built RawItem objects directly — the query
// string itself is never round-tripped through anything GraphQL-aware.
// This is a cheap syntax-shape guard, not a full parser, but it locks the
// specific failure mode that shipped.
describe('GraphQL query fragment syntax', () => {
  it('itemContentSelection has no JS-style // comments (invalid GraphQL)', () => {
    expect(itemContentSelection(true)).not.toMatch(/\/\//)
    expect(itemContentSelection(false)).not.toMatch(/\/\//)
  })

  it('FIELD_CONFIG_FRAGMENT and FIELD_VALUES_SELECTION have no // comments', () => {
    expect(FIELD_CONFIG_FRAGMENT).not.toMatch(/\/\//)
    expect(FIELD_VALUES_SELECTION).not.toMatch(/\/\//)
  })

  it('itemContentSelection keeps braces balanced (catches a stray extra `}`)', () => {
    for (const includeParent of [true, false]) {
      const text = itemContentSelection(includeParent)
      const opens = (text.match(/\{/g) ?? []).length
      const closes = (text.match(/\}/g) ?? []).length
      expect(closes).toBe(opens)
    }
  })
})
