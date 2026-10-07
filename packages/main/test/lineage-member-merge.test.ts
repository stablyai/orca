import { describe, expect, it } from 'vitest'
import type { LineageMember } from '../../../src/shared/lineage-discovery-types'
import { mergeLineageMembers } from '../../../src/main/lineage/lineage-member-merge'

const base = { repoName: 'loan-core', branch: 'feat/levgp-483' }
const m = (over: Partial<LineageMember>): LineageMember => ({
  ...base,
  worktreePath: '/w/loan-core',
  matchedBy: 'pattern',
  reasons: ['branch contains LEVGP-483'],
  ...over
})

describe('mergeLineageMembers', () => {
  it('keeps the tower flag whichever merged input carries it', () => {
    const towerFirst = mergeLineageMembers([
      m({ matchedBy: 'lineage', isTower: true }),
      m({ matchedBy: 'manual', pr: { number: 3 } })
    ])
    const towerLast = mergeLineageMembers([
      m({ matchedBy: 'manual', pr: { number: 3 } }),
      m({ matchedBy: 'lineage', isTower: true })
    ])
    expect(towerFirst[0].isTower).toBe(true)
    expect(towerLast[0].isTower).toBe(true)
  })

  it('never invents the tower flag', () => {
    const merged = mergeLineageMembers([m({ matchedBy: 'pattern' }), m({ matchedBy: 'lineage' })])
    expect(merged[0].isTower).toBeUndefined()
  })

  it('keeps one row per worktree with the strongest source and all reasons', () => {
    const merged = mergeLineageMembers([
      m({ matchedBy: 'pattern', reasons: ['pattern'] }),
      m({ matchedBy: 'lineage', reasons: ['lineage'] })
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].matchedBy).toBe('lineage')
    expect(merged[0].reasons).toEqual(['lineage', 'pattern'])
  })

  it('lets manual win over lineage and pattern', () => {
    const merged = mergeLineageMembers([
      m({ matchedBy: 'lineage', reasons: ['lineage'] }),
      m({ matchedBy: 'manual', reasons: ['manual'], pr: { number: 7, url: 'u' } })
    ])
    expect(merged[0].matchedBy).toBe('manual')
    expect(merged[0].pr?.number).toBe(7)
  })

  it('merges a worktree-less manual PR into the worktree member with the same repo and branch', () => {
    const merged = mergeLineageMembers([
      m({ matchedBy: 'pattern' }),
      m({ worktreePath: undefined, matchedBy: 'manual', pr: { number: 9, url: 'u' } })
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].worktreePath).toBe('/w/loan-core')
    expect(merged[0].pr?.number).toBe(9)
  })

  it('keeps a manual PR without a worktree as its own member', () => {
    const merged = mergeLineageMembers([
      m({
        worktreePath: undefined,
        branch: 'other',
        matchedBy: 'manual',
        pr: { number: 3, url: 'u' }
      })
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].worktreePath).toBeUndefined()
  })

  it('keeps two branchless manual PRs in the same repo as two members', () => {
    const manual = (id: string, number: number): LineageMember =>
      m({
        worktreePath: undefined,
        branch: '',
        matchedBy: 'manual',
        manualLinkId: id,
        pr: { number, url: 'u' }
      })
    const merged = mergeLineageMembers([manual('a', 1), manual('b', 2)])
    expect(merged.map((member) => member.pr?.number)).toEqual([1, 2])
  })
})
