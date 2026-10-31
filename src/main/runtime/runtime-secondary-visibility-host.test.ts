import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false },
  BrowserWindow: { fromId: () => null },
  webContents: { fromId: () => null },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() }
}))
import { OrcaRuntimeService } from './orca-runtime'
import { partialRuntimeStore, storeWorktreeMeta } from './runtime-store-partial-fixture'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'

class VisibilityRuntime extends OrcaRuntimeService {
  rows: ResolvedWorktree[] = []
  protected override async listResolvedWorktrees() {
    return this.rows
  }
  fileTarget(path: string) {
    return this.resolveKnownWorkspaceFileTarget(path, 'local')
  }
  visible() {
    return this.visibleResolvedWorktreeSnapshot({
      worktrees: this.rows,
      platformByRepoId: new Map()
    }).worktrees
  }
}

function checkout(path: string, hostId?: ExecutionHostId): ResolvedWorktree {
  return {
    ...storeWorktreeMeta(),
    head: 'abc',
    isBare: false,
    id: `twin::${path}`,
    repoId: 'twin',
    path,
    displayName: path,
    branch: 'review',
    isMainWorktree: false,
    hostId,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    git: { path, head: 'abc', branch: 'review', isBare: false, isMainWorktree: false }
  }
}

describe('secondary runtime visibility readers', () => {
  it.each([false, true])(
    'keeps twin-host policies separate in either repo order (reverse=%s)',
    async (reverse) => {
      const local: Repo = {
        id: 'twin',
        path: '/local',
        displayName: 'Local',
        badgeColor: 'blue',
        addedAt: 1,
        executionHostId: 'local',
        externalWorktreeVisibility: 'hide',
        externalWorktreeVisibilityLegacy: false,
        customWorktreeVisibilitySources: [{ id: 'owned', rootPath: '/scratch' }],
        worktreeVisibilitySourcePreferences: { custom: { owned: 'show' } }
      }
      const remote: Repo = {
        ...local,
        path: '/remote',
        executionHostId: 'ssh:remote',
        connectionId: 'remote',
        worktreeVisibilitySourcePreferences: { custom: { owned: 'hide' } }
      }
      const runtime = new VisibilityRuntime(
        partialRuntimeStore({ getRepos: () => (reverse ? [remote, local] : [local, remote]) })
      )
      runtime.rows = [
        checkout('/scratch/local', 'local'),
        checkout('/scratch/remote', 'ssh:remote'),
        checkout('/scratch/ambiguous')
      ]
      expect(runtime.visible().map((row) => row.path)).toEqual(['/scratch/local'])
      expect(await runtime.fileTarget('/scratch/local/file.ts')).toMatchObject({
        executionHostId: 'local',
        relativePath: 'file.ts',
        worktree: { path: '/scratch/local' }
      })
      expect(await runtime.fileTarget('/scratch/remote/file.ts')).toBeNull()
      expect(await runtime.fileTarget('/scratch/ambiguous/file.ts')).toBeNull()
    }
  )
})
