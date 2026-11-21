import { describe, expect, it, vi } from 'vitest'
import {
  createProjectGroupNameLookup,
  createRepoNameLookup,
  resolveWorktreeMemoryNames,
  type MemorySnapshotStore
} from './memory-snapshot-buckets'

describe('resolveWorktreeMemoryNames', () => {
  it('reads each repo once per snapshot however many of its workspaces are sampled', () => {
    const getRepo = vi.fn((id: string) => (id === 'repo-a' ? { displayName: 'Alpha' } : undefined))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: name resolution reads only the store members stubbed here.
    const store = {
      getRepo,
      getWorktreeMeta: () => undefined,
      getProjectGroups: () => []
    } as unknown as MemorySnapshotStore
    const projectGroupName = createProjectGroupNameLookup(store)
    const repoName = createRepoNameLookup(store)

    const names = Array.from({ length: 50 }, (_, i) =>
      resolveWorktreeMemoryNames(`repo-a::/w/${i}`, store, projectGroupName, repoName)
    )

    expect(getRepo).toHaveBeenCalledTimes(1)
    expect(names[49]).toEqual({ worktreeName: '49', repoId: 'repo-a', repoName: 'Alpha' })
  })
})

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
