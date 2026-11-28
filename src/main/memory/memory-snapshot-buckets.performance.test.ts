import { describe, expect, it, vi } from 'vitest'
import { createProjectGroupNameLookup, type MemorySnapshotStore } from './memory-snapshot-buckets'

describe('createProjectGroupNameLookup', () => {
  it('reads one group by id instead of sorting every group each sample', () => {
    const getProjectGroup = vi.fn((id: string) =>
      id === 'group-a' ? { id: 'group-a', name: 'Bots' } : undefined
    )
    const getProjectGroups = vi.fn(() => [])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lookup reads only the store members stubbed here.
    const store = {
      getRepo: () => undefined,
      getWorktreeMeta: () => undefined,
      getProjectGroup,
      getProjectGroups
    } as unknown as MemorySnapshotStore
    const projectGroupName = createProjectGroupNameLookup(store)

    expect([projectGroupName('group-a'), projectGroupName('group-a')]).toEqual(['Bots', 'Bots'])
    expect(getProjectGroup).toHaveBeenCalledTimes(1)
    expect(getProjectGroups).not.toHaveBeenCalled()
  })
})
