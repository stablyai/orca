import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  collectIdOnlyStoreWrites,
  findIdOnlyLookups,
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

const LOOKUP_SOURCE = `export class SetupOps {
  updateProjectHostSetup(args: Args): Result | null {
    const repo = setup.repoId
      ? this.state.repos.find((entry) => entry.id === setup.repoId)
      : undefined
    return repo
  }

  private findSetupRepo(setup: ProjectHostSetup): Repo | undefined {
    return this.state.repos.find(
      (entry) => entry.id === setup.repoId && getRepoExecutionHostId(entry) === setup.hostId
    )
  }
}

export const pickRepo = (state: State, repoId: string): number =>
  state.repos.findIndex(
    (repo) =>
      repo.id === repoId
  )

function pickOptional(state: State, repoId: string): Repo | undefined {
  return state.repos?.find(({ id }) => id === repoId)
}
`

describe('findIdOnlyLookups', () => {
  it('flags a repo-row lookup by id alone (review-5 #10), by its enclosing function', () => {
    expect(findIdOnlyLookups('ops.ts', LOOKUP_SOURCE)).toEqual([
      'lookup:ops.ts#updateProjectHostSetup',
      'lookup:ops.ts#pickRepo',
      'lookup:ops.ts#pickOptional'
    ])
  })
})

describe('listStoreOperationClasses', () => {
  it('finds an operations class whose import also brings in a function', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'id-only-ratchet-'))
    const file = path.join(root, 'src/main/persistence/loading-store/store-domain-composition.ts')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      [
        "import { RowOps } from './row-ops'",
        "import { scheduleSave, WriteOps } from './write-ops'",
        'const STORE_DOMAIN_OPERATION_CLASSES = [RowOps, WriteOps]'
      ].join('\n')
    )
    try {
      expect(listStoreOperationClasses(root)).toEqual([
        ['RowOps', 'src/main/persistence/loading-store/row-ops.ts'],
        ['WriteOps', 'src/main/persistence/loading-store/write-ops.ts']
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
