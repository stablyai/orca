import { describe, expect, it } from 'vitest'
import { mergeWorktreeMetaForWrite } from './worktree-meta-write-normalization'

const GROUPS = {
  groups: [{ id: 'g1', name: '  PA4 ', createdAt: 1 }],
  groupIdByTabId: { 'tab-a': 'g1', 'tab-b': 'missing' }
}

describe('task groups written with worktree meta', () => {
  it('stores a normalized set and clears it on null or an empty set', () => {
    const saved = mergeWorktreeMetaForWrite(undefined, { agentTaskGroups: GROUPS })
    expect(saved.agentTaskGroups).toEqual({
      groups: [{ id: 'g1', name: 'PA4', createdAt: 1 }],
      groupIdByTabId: { 'tab-a': 'g1' }
    })
    expect(mergeWorktreeMetaForWrite(saved, { comment: 'x' }).agentTaskGroups).toEqual(
      saved.agentTaskGroups
    )
    expect(mergeWorktreeMetaForWrite(saved, { agentTaskGroups: null })).not.toHaveProperty(
      'agentTaskGroups'
    )
    expect(
      mergeWorktreeMetaForWrite(saved, { agentTaskGroups: { groups: [], groupIdByTabId: {} } })
    ).not.toHaveProperty('agentTaskGroups')
  })
})
