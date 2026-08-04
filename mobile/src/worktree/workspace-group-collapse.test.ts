import { describe, expect, it } from 'vitest'
import {
  areAllSectionsCollapsed,
  collapseAllSections,
  expandAllSections,
  toggleAllSectionsCollapsed
} from '../../../src/shared/workspace-group-collapse'
import { MOBILE_WORKSPACE_LINEAGE_KEY_PREFIX } from './mobile-workspace-lineage'

const PRESERVED = [MOBILE_WORKSPACE_LINEAGE_KEY_PREFIX]

describe('areAllSectionsCollapsed', () => {
  it('is false with no sections', () => {
    expect(areAllSectionsCollapsed(new Set(['repo:a']), [])).toBe(false)
  })

  it('is false while any section stays expanded', () => {
    expect(areAllSectionsCollapsed(new Set(['repo:a']), ['repo:a', 'repo:b'])).toBe(false)
  })

  it('is true once every section key is collapsed', () => {
    expect(areAllSectionsCollapsed(new Set(['repo:a', 'repo:b']), ['repo:a', 'repo:b'])).toBe(true)
  })

  it('ignores unrelated keys in the collapsed set', () => {
    const collapsed = new Set(['repo:a', 'workspace-lineage:wt-1'])
    expect(areAllSectionsCollapsed(collapsed, ['repo:a'])).toBe(true)
  })
})

describe('toggleAllSectionsCollapsed', () => {
  it('collapses every section when any is expanded', () => {
    const next = toggleAllSectionsCollapsed(
      new Set(['repo:a']),
      ['pinned', 'repo:a', 'repo:b'],
      PRESERVED
    )
    expect(new Set(next)).toEqual(new Set(['pinned', 'repo:a', 'repo:b']))
  })

  it('expands every section when all are collapsed', () => {
    const next = toggleAllSectionsCollapsed(
      new Set(['repo:a', 'repo:b']),
      ['repo:a', 'repo:b'],
      PRESERVED
    )
    expect(next).toEqual([])
  })

  it('keeps lineage keys and clears stale section keys on expand', () => {
    const lineage = 'workspace-lineage:wt-1'
    // Stale key left behind by another group mode; collapse keeps it, expand clears it.
    const stale = 'workspace-status:done'
    const collapsed = toggleAllSectionsCollapsed(new Set([lineage, stale]), ['repo:a'], PRESERVED)
    expect(new Set(collapsed)).toEqual(new Set([lineage, stale, 'repo:a']))
    const expanded = toggleAllSectionsCollapsed(new Set(collapsed), ['repo:a'], PRESERVED)
    expect(expanded).toEqual([lineage])
  })

  it('supports multiple preserved prefixes (desktop lineage + host sections)', () => {
    const set = new Set(['project:p1', 'lineage:wt-1', 'host:ssh-1'])
    const expanded = toggleAllSectionsCollapsed(set, ['project:p1'], ['lineage:', 'host:'])
    expect(new Set(expanded)).toEqual(new Set(['lineage:wt-1', 'host:ssh-1']))
  })

  it('returns the set unchanged when there are no sections', () => {
    expect(toggleAllSectionsCollapsed(new Set(['repo:a']), [], PRESERVED)).toEqual(['repo:a'])
  })
})

describe('directional bulk operations', () => {
  it('collapseAllSections unions keys without touching unrelated ones', () => {
    const next = collapseAllSections(new Set(['workspace-lineage:wt-1']), ['repo:a', 'repo:b'])
    expect(new Set(next)).toEqual(new Set(['workspace-lineage:wt-1', 'repo:a', 'repo:b']))
  })

  it('expandAllSections keeps only preserved prefixes', () => {
    const set = new Set(['project:p1', 'pinned', 'lineage:wt-1', 'host:ssh-1'])
    expect(new Set(expandAllSections(set, ['lineage:', 'host:']))).toEqual(
      new Set(['lineage:wt-1', 'host:ssh-1'])
    )
  })
})
