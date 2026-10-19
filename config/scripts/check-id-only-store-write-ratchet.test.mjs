import { describe, expect, it } from 'vitest'

import {
  collectIdOnlyStoreWrites,
  findIdOnlyWrites,
  listStoreOperationClasses,
  NOT_HOST_TWINNED
} from './check-id-only-store-write-ratchet.mjs'

const SOURCE = `export class RowOps {
  constructor(runtime: string) {}

  moveProjectToGroup(repoId: string, groupId: string | null): void {}

  updateFolderWorkspace(
    id: string,
    updates: object
  ): void {}

  removeWorktreeMeta(worktreeId?: string): void {}

  getWorktreeMeta(worktreeId: string): void {}

  updateRepo(target: RepoHostTarget): void {}

  reorderRepos(orderedIds: string[]): void {}

  setRemoteLayoutSnapshot(environmentId: string): void {}

  private writeRow(repoId: string): void {}

  public renameRepo(repoId: Repo['id']): void {}

  override setLineage<T>(worktreeKey: WorktreeKey, value: T): void {}

  removeWorkspaceLineage(childWorkspaceKey: WorkspaceKey): void {}

  dropRow = (id: BrandedRepoId): void => {}

  moveRow(target: RepoHostTarget): void {}

  dropWorktree(worktreeId: HostWorktreeTarget): void {}

  removeSessionHost(hostId: ExecutionHostId): void {}
}

export class Other {
  setWorktreeLineage(worktreeId: string): void {}
}
`

describe('findIdOnlyWrites', () => {
  it('lists public writes whose first parameter is an id by name, whatever its type', () => {
    expect(findIdOnlyWrites('RowOps', SOURCE)).toEqual([
      'RowOps.moveProjectToGroup',
      'RowOps.updateFolderWorkspace',
      'RowOps.removeWorktreeMeta',
      'RowOps.reorderRepos',
      'RowOps.setRemoteLayoutSnapshot',
      'RowOps.renameRepo',
      'RowOps.setLineage',
      'RowOps.removeWorkspaceLineage',
      'RowOps.dropRow',
      // Param exemptions are per class, so these host-named params count on RowOps.
      'RowOps.removeSessionHost'
    ])
  })

  it('stays inside the named class', () => {
    expect(findIdOnlyWrites('Other', SOURCE)).toEqual(['Other.setWorktreeLineage'])
    expect(findIdOnlyWrites('Missing', SOURCE)).toEqual([])
  })
})

describe('collectIdOnlyStoreWrites', () => {
  it('scans every Store operations class and skips the documented exemptions', () => {
    expect(listStoreOperationClasses(process.cwd()).length).toBeGreaterThan(10)
    const entries = collectIdOnlyStoreWrites(process.cwd())
    expect(entries).not.toContain('RepoLifecycleOperations.updateRepo')
    for (const exempt of NOT_HOST_TWINNED.keys()) {
      expect(entries).not.toContain(exempt)
    }
  })
})
