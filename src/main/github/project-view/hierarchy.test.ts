// Why: Phase 2 — mirrors the Phase 1b TDD discipline (project-view.test.ts):
// pure normalizer functions are tested directly against hand-built raw
// fixtures, no `gh` mocking needed. Live network verification happens
// separately (see docs/reference/2026-07-15-github-projects-hierarchy-phase2-plan.md
// step 13), not in this file.
import { describe, expect, it } from 'vitest'
import {
  HIERARCHY_CHILDREN_PAGE_SIZE,
  HIERARCHY_GRANDCHILDREN_PAGE_SIZE,
  normalizeHierarchyResponse,
  validateAddSubIssueArgs,
  validateReprioritizeSubIssueArgs,
  type RawHierarchyIssue
} from './hierarchy'
import {
  addSubIssueBySlug,
  buildResolveIssueIdsQuery,
  removeSubIssueBySlug,
  reprioritizeSubIssueBySlug
} from './hierarchy-mutations'

describe('normalizeHierarchyResponse', () => {
  it('returns null for a null/undefined raw issue (not_found upstream)', () => {
    expect(normalizeHierarchyResponse(null)).toBeNull()
    expect(normalizeHierarchyResponse(undefined)).toBeNull()
  })

  it('maps a leaf issue with no parent and no sub-issues', () => {
    const raw: RawHierarchyIssue = {
      parent: null,
      subIssuesSummary: null,
      subIssues: { totalCount: 0, nodes: [] }
    }
    const result = normalizeHierarchyResponse(raw)
    expect(result).toEqual({
      parent: null,
      subIssuesSummary: null,
      subIssues: [],
      hasMoreChildren: false
    })
  })

  it('maps a present parent', () => {
    const raw: RawHierarchyIssue = {
      parent: { number: 37, title: 'Epic', url: 'https://github.com/x/y/issues/37' },
      subIssuesSummary: null,
      subIssues: { totalCount: 0, nodes: [] }
    }
    const result = normalizeHierarchyResponse(raw)
    expect(result?.parent).toEqual({
      number: 37,
      title: 'Epic',
      url: 'https://github.com/x/y/issues/37'
    })
  })

  it('drops a malformed parent (missing url) rather than throwing', () => {
    const raw = {
      parent: { number: 37, title: 'Epic' },
      subIssuesSummary: null,
      subIssues: { totalCount: 0, nodes: [] }
    } as unknown as RawHierarchyIssue
    const result = normalizeHierarchyResponse(raw)
    expect(result?.parent).toBeNull()
  })

  it('maps direct children with their own subIssuesSummary', () => {
    const raw: RawHierarchyIssue = {
      parent: null,
      subIssuesSummary: { total: 2, completed: 1, percentCompleted: 50 },
      subIssues: {
        totalCount: 2,
        nodes: [
          {
            number: 38,
            title: 'Story A',
            url: 'https://github.com/x/y/issues/38',
            state: 'OPEN',
            subIssuesSummary: { total: 1, completed: 0, percentCompleted: 0 },
            subIssues: { totalCount: 0, nodes: [] }
          },
          {
            number: 39,
            title: 'Story B',
            url: 'https://github.com/x/y/issues/39',
            state: 'CLOSED',
            subIssuesSummary: null,
            subIssues: { totalCount: 0, nodes: [] }
          }
        ]
      }
    }
    const result = normalizeHierarchyResponse(raw)
    expect(result?.subIssuesSummary).toEqual({ total: 2, completed: 1, percentCompleted: 50 })
    expect(result?.subIssues).toHaveLength(2)
    expect(result?.subIssues[0]).toEqual({
      number: 38,
      title: 'Story A',
      url: 'https://github.com/x/y/issues/38',
      state: 'OPEN',
      subIssuesSummary: { total: 1, completed: 0, percentCompleted: 0 },
      subIssues: []
    })
  })

  it('recurses into a second level of grandchildren', () => {
    const raw: RawHierarchyIssue = {
      parent: null,
      subIssuesSummary: { total: 1, completed: 0, percentCompleted: 0 },
      subIssues: {
        totalCount: 1,
        nodes: [
          {
            number: 38,
            title: 'Story A',
            url: 'https://github.com/x/y/issues/38',
            state: 'OPEN',
            subIssuesSummary: { total: 1, completed: 0, percentCompleted: 0 },
            subIssues: {
              totalCount: 1,
              nodes: [
                {
                  number: 40,
                  title: 'Task 1',
                  url: 'https://github.com/x/y/issues/40',
                  state: 'OPEN',
                  subIssuesSummary: null,
                  subIssues: { totalCount: 0, nodes: [] }
                }
              ]
            }
          }
        ]
      }
    }
    const result = normalizeHierarchyResponse(raw)
    expect(result?.subIssues[0].subIssues).toEqual([
      {
        number: 40,
        title: 'Task 1',
        url: 'https://github.com/x/y/issues/40',
        state: 'OPEN',
        subIssuesSummary: null,
        subIssues: []
      }
    ])
  })

  it('drops a malformed sub-issue node (missing number) rather than throwing', () => {
    const raw = {
      parent: null,
      subIssuesSummary: { total: 1, completed: 0, percentCompleted: 0 },
      subIssues: {
        totalCount: 1,
        nodes: [{ title: 'Broken', url: 'x', state: 'OPEN' }, null]
      }
    } as unknown as RawHierarchyIssue
    const result = normalizeHierarchyResponse(raw)
    expect(result?.subIssues).toEqual([])
  })

  it('sets hasMoreChildren when the direct-children page did not cover totalCount', () => {
    const raw: RawHierarchyIssue = {
      parent: null,
      subIssuesSummary: { total: 5, completed: 0, percentCompleted: 0 },
      subIssues: {
        totalCount: 5,
        nodes: Array.from({ length: HIERARCHY_CHILDREN_PAGE_SIZE }, (_, i) => ({
          number: i + 1,
          title: `Child ${i}`,
          url: `https://github.com/x/y/issues/${i + 1}`,
          state: 'OPEN',
          subIssuesSummary: null,
          subIssues: { totalCount: 0, nodes: [] }
        }))
      }
    }
    // totalCount (5) is less than the page size constant in this fixture's
    // node count only if the fixture deliberately under/over-fills it — here
    // we directly assert against a totalCount greater than nodes.length.
    const underfilled: RawHierarchyIssue = {
      ...raw,
      subIssues: { totalCount: 999, nodes: raw.subIssues?.nodes ?? [] }
    }
    expect(normalizeHierarchyResponse(underfilled)?.hasMoreChildren).toBe(true)
    expect(normalizeHierarchyResponse(raw)?.hasMoreChildren).toBe(false)
  })

  it('sets hasMoreChildren when a grandchild page did not cover its own totalCount', () => {
    const raw: RawHierarchyIssue = {
      parent: null,
      subIssuesSummary: { total: 1, completed: 0, percentCompleted: 0 },
      subIssues: {
        totalCount: 1,
        nodes: [
          {
            number: 38,
            title: 'Story A',
            url: 'https://github.com/x/y/issues/38',
            state: 'OPEN',
            subIssuesSummary: { total: 999, completed: 0, percentCompleted: 0 },
            subIssues: {
              totalCount: 999,
              nodes: [
                {
                  number: 40,
                  title: 'Task 1',
                  url: 'https://github.com/x/y/issues/40',
                  state: 'OPEN',
                  subIssuesSummary: null,
                  subIssues: { totalCount: 0, nodes: [] }
                }
              ]
            }
          }
        ]
      }
    }
    expect(normalizeHierarchyResponse(raw)?.hasMoreChildren).toBe(true)
  })
})

describe('validateAddSubIssueArgs', () => {
  it('rejects a self-reference (issue cannot be its own sub-issue)', () => {
    const result = validateAddSubIssueArgs({
      owner: 'acme',
      repo: 'widgets',
      number: 5,
      subIssueNumber: 5
    })
    expect(result.ok).toBe(false)
  })

  it('accepts a valid distinct pair', () => {
    const result = validateAddSubIssueArgs({
      owner: 'acme',
      repo: 'widgets',
      number: 5,
      subIssueNumber: 6
    })
    expect(result.ok).toBe(true)
  })

  it('rejects an invalid owner slug', () => {
    const result = validateAddSubIssueArgs({
      owner: '.bad',
      repo: 'widgets',
      number: 5,
      subIssueNumber: 6
    })
    expect(result.ok).toBe(false)
  })
})

describe('validateReprioritizeSubIssueArgs', () => {
  it('rejects when both beforeNumber and afterNumber are provided', () => {
    const result = validateReprioritizeSubIssueArgs({
      owner: 'acme',
      repo: 'widgets',
      number: 5,
      subIssueNumber: 6,
      beforeNumber: 7,
      afterNumber: 8
    })
    expect(result.ok).toBe(false)
  })

  it('accepts moving to the end (neither before nor after)', () => {
    const result = validateReprioritizeSubIssueArgs({
      owner: 'acme',
      repo: 'widgets',
      number: 5,
      subIssueNumber: 6
    })
    expect(result.ok).toBe(true)
  })

  it('rejects a self-reference against beforeNumber', () => {
    const result = validateReprioritizeSubIssueArgs({
      owner: 'acme',
      repo: 'widgets',
      number: 5,
      subIssueNumber: 6,
      beforeNumber: 6
    })
    expect(result.ok).toBe(false)
  })
})

describe('page size constants', () => {
  it('are positive and grandchildren page is not larger than children page', () => {
    expect(HIERARCHY_CHILDREN_PAGE_SIZE).toBeGreaterThan(0)
    expect(HIERARCHY_GRANDCHILDREN_PAGE_SIZE).toBeGreaterThan(0)
    expect(HIERARCHY_GRANDCHILDREN_PAGE_SIZE).toBeLessThanOrEqual(HIERARCHY_CHILDREN_PAGE_SIZE)
  })
})

// Why: the mutation entry points validate args BEFORE touching the
// network (see validateAddSubIssueArgs et al.) — invalid args resolve
// immediately without spawning `gh`, so this is safe to test directly
// without mocking. Valid-args happy-path is verified live (plan step 13),
// not here — mirrors how project-view.test.ts never mocks `gh` either.
describe('mutation entry points reject invalid args before touching the network', () => {
  it('addSubIssueBySlug rejects an invalid owner without a network call', async () => {
    const result = await addSubIssueBySlug({
      owner: '.bad',
      repo: 'widgets',
      number: 5,
      subIssueNumber: 6
    })
    expect(result.ok).toBe(false)
  })

  it('addSubIssueBySlug rejects a self-reference without a network call', async () => {
    const result = await addSubIssueBySlug({
      owner: 'acme',
      repo: 'widgets',
      number: 5,
      subIssueNumber: 5
    })
    expect(result.ok).toBe(false)
  })

  it('removeSubIssueBySlug rejects an invalid repo without a network call', async () => {
    const result = await removeSubIssueBySlug({
      owner: 'acme',
      repo: '..',
      number: 5,
      subIssueNumber: 6
    })
    expect(result.ok).toBe(false)
  })

  it('reprioritizeSubIssueBySlug rejects conflicting before/after without a network call', async () => {
    const result = await reprioritizeSubIssueBySlug({
      owner: 'acme',
      repo: 'widgets',
      number: 5,
      subIssueNumber: 6,
      beforeNumber: 7,
      afterNumber: 8
    })
    expect(result.ok).toBe(false)
  })
})

describe('buildResolveIssueIdsQuery', () => {
  it('builds one aliased issue field per distinct number', () => {
    const query = buildResolveIssueIdsQuery(3)
    expect(query).toContain('i0: issue(number: $n0) { id }')
    expect(query).toContain('i1: issue(number: $n1) { id }')
    expect(query).toContain('i2: issue(number: $n2) { id }')
    expect(query).not.toContain('i3:')
  })

  it('declares matching $n{i}: Int! variables in the operation signature', () => {
    const query = buildResolveIssueIdsQuery(2)
    expect(query).toContain('$n0: Int!')
    expect(query).toContain('$n1: Int!')
  })
})
