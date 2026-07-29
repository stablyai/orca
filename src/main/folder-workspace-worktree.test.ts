import { describe, expect, it } from 'vitest'
import type { Repo, WorktreeMeta } from '../shared/types'
import {
  getFolderWorkspaceInstanceId,
  getFolderWorkspaceInstanceIdentity,
  getFolderWorkspaceRootId,
  isFolderWorkspaceIdForRepo,
  mergeFolderWorkspace
} from './folder-workspace-worktree'

function makeRepo(path: string): Repo {
  return { id: 'repo-1', path, displayName: 'Orca' } as Repo
}

describe('folder workspace worktree', () => {
  it.each(['C:\\Users\\johnson\\orca', '/home/johnson/orca'])(
    'preserves %s in folder workspace identities',
    (path) => {
      const repo = makeRepo(path)
      const rootId = getFolderWorkspaceRootId(repo)
      const childId = getFolderWorkspaceInstanceId(repo, 'child-1')

      expect(rootId).toBe(`repo-1::${path}`)
      expect(childId).toBe(`${rootId}::workspace:child-1`)
      expect(getFolderWorkspaceInstanceIdentity(repo, childId)).toBe('child-1')
      expect(isFolderWorkspaceIdForRepo(repo, rootId)).toBe(true)
      expect(isFolderWorkspaceIdForRepo(repo, childId)).toBe(true)
      expect(isFolderWorkspaceIdForRepo(makeRepo('/other/orca'), childId)).toBe(false)
    }
  )

  it('maps metadata without changing created or activity timestamps', () => {
    const repo = makeRepo('/workspace/orca')
    const rootId = getFolderWorkspaceRootId(repo)
    const childId = getFolderWorkspaceInstanceId(repo, 'child-1')
    const meta = {
      instanceId: 'child-1',
      projectId: 'github:stablyai/orca',
      hostId: 'local',
      projectHostSetupId: 'setup-1',
      displayName: 'Issue 10948',
      comment: 'Keep this shared',
      createdAt: 100,
      lastActivityAt: 200
    } as WorktreeMeta

    expect(mergeFolderWorkspace(repo, rootId, meta)).toMatchObject({
      id: rootId,
      isMainWorktree: true,
      path: repo.path
    })
    expect(mergeFolderWorkspace(repo, childId, meta)).toMatchObject({
      id: childId,
      instanceId: 'child-1',
      isMainWorktree: false,
      projectId: 'github:stablyai/orca',
      hostId: 'local',
      projectHostSetupId: 'setup-1',
      createdAt: 100,
      lastActivityAt: 200
    })
  })
})
