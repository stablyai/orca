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
