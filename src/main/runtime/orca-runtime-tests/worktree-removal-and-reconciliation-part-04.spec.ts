import * as gitExecFile from '../../git/command-runner/git-exec-file'
import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import {
  MOCK_GIT_WORKTREES,
  restoreLocalWatcherAfterFailedRemovalMock,
  removeWorktreeLinkedPathsMock
} from '../orca-runtime-test-mocks/setup.spec'
import { assertWorktreeCleanForRemoval } from '../../git/worktrees/removal/worktree-removal-preflight'
import { getEffectiveHooks, runHook } from '../../workspace-hooks/hooks'
import { join } from 'node:path'
import { listWorktrees } from '../../git/worktrees/catalog/worktree-scan-cache'
import { listWorktreesStrict } from '../../git/worktrees/catalog/worktree-listing'
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { removeWorktree } from '../../git/worktrees/removal/worktree-removal'
import { tmpdir } from 'node:os'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import {
  hostWorktreeTarget,
  type HostWorktreeTarget
} from '../../../shared/worktree/host-qualified-identity'
import {
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  createStaleRuntimeWorktreeStore,
  makeWorktreeMeta,
  store,
  syncSinglePty
} from './orca-runtime-test-fixtures.spec'
import { createWorktreeRemovalRuntime } from './orca-runtime-test-scenario-builders.spec'

describe('OrcaRuntimeService', () => {
  it('does not inspect or delete a local path for an SSH runtime orphan this process does not serve', async () => {
    const localPath = await mkdtemp(join(tmpdir(), 'orca-runtime-ssh-missing-fs-'))
    const repo = {
      id: 'repo-runtime-ssh-missing-fs',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-missing-fs'
    }
    const worktreeId = `${repo.id}::${localPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [worktreeId]: makeWorktreeMeta({
        orcaCreatedAt: Date.now(),
        orcaCreationSource: 'ssh'
      })
    }
    const removeWorktreeMeta = vi.fn(({ id }: HostWorktreeTarget) => {
      delete metaById[id]
    })
    const runtimeStore = {
      ...store,
      getRepos: () => [repo],
      getRepo: (id: string) => (id === repo.id ? repo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (id: string) => metaById[id],
      setWorktreeMeta: ({ id }: HostWorktreeTarget, meta: Partial<WorktreeMeta>) => {
        metaById[id] = { ...(metaById[id] ?? makeWorktreeMeta()), ...meta }
        return metaById[id]
      },
      removeWorktreeMeta
    }
    const runtime = createWorktreeRemovalRuntime(runtimeStore)

    try {
      await expect(
        runtime.removeManagedWorktree(`id:${worktreeId}`, { force: true })
      ).rejects.toThrow('isn’t served by Orca’s server')

      await expect(lstat(localPath)).resolves.toBeTruthy()
      expect(removeWorktree).not.toHaveBeenCalled()
      expect(removeWorktreeMeta).not.toHaveBeenCalled()
    } finally {
      await rm(localPath, { recursive: true, force: true })
    }
  })

  it('rechecks a runtime Git lock after the archive hook before teardown', async () => {
    const repo = { ...store.getRepos()[0], symlinkPaths: ['node_modules'] }
    const runtimeStore = {
      ...store,
      getRepos: () => [repo],
      getRepo: () => repo
    }
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    const killSpy = vi.fn().mockReturnValue(true)
    runtime.setPtyController({
      write: () => true,
      kill: (id) => killSpy(id),
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime, 'pty-1')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: { archive: 'pnpm worktree:archive' }
    })
    vi.mocked(runHook).mockResolvedValue({ success: true, output: '' })
    vi.mocked(listWorktreesStrict)
      .mockResolvedValueOnce(MOCK_GIT_WORKTREES)
      .mockResolvedValueOnce([
        {
          ...MOCK_GIT_WORKTREES[0],
          locked: true,
          lockReason: 'locked during archive'
        }
      ])

    await expect(
      runtime.removeManagedWorktree(TEST_WORKTREE_ID, { force: true, runHooks: true })
    ).rejects.toThrow('Worktree is locked by Git')

    expect(runHook).toHaveBeenCalled()
    expect(removeWorktreeLinkedPathsMock).not.toHaveBeenCalled()
    expect(assertWorktreeCleanForRemoval).not.toHaveBeenCalled()
    expect(killSpy).not.toHaveBeenCalled()
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('retains metadata when an unproven orphan directory survives cleanup', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'orca-runtime-orphan-retention-'))
    const repoPath = join(parentDir, 'repo')
    const orphanPath = join(parentDir, 'orphan')
    const worktreeId = `${TEST_REPO_ID}::${orphanPath}`
    await mkdir(orphanPath, { recursive: true })
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(worktreeId)
    const runtimeStoreWithRepoPath = {
      ...runtimeStore,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: repoPath,
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1
        }
      ],
      getRepo: (id: string) =>
        id === TEST_REPO_ID
          ? {
              id: TEST_REPO_ID,
              path: repoPath,
              displayName: 'repo',
              badgeColor: 'blue',
              addedAt: 1
            }
          : undefined
    }
    const runtime = createWorktreeRemovalRuntime(runtimeStoreWithRepoPath)
    const registeredWorktree = {
      path: orphanPath,
      head: 'abc',
      branch: 'feature/orphan',
      isBare: false,
      isMainWorktree: false
    }
    vi.mocked(listWorktrees).mockResolvedValue([registeredWorktree])
    vi.mocked(listWorktreesStrict).mockResolvedValue([registeredWorktree])
    vi.mocked(removeWorktree).mockRejectedValue(
      Object.assign(new Error('git worktree remove failed'), {
        stderr: `fatal: '${orphanPath}' is not a working tree`
      })
    )
    vi.mocked(assertWorktreeCleanForRemoval).mockRejectedValue(
      Object.assign(new Error('status failed'), {
        stderr: 'fatal: not a git repository (or any of the parent directories): .git\n'
      })
    )
    const gitSpy = vi.spyOn(gitExecFile, 'gitExecFileAsync').mockResolvedValue({
      stdout: '',
      stderr: ''
    })

    try {
      await expect(runtime.removeManagedWorktree(worktreeId)).rejects.toThrow(
        'Worktree is no longer registered with Git but its directory remains.'
      )
      await expect(lstat(orphanPath)).resolves.toBeTruthy()
      expect(removeWorktreeMeta).not.toHaveBeenCalled()
      expect(restoreLocalWatcherAfterFailedRemovalMock).toHaveBeenCalledWith(orphanPath)

      await rm(orphanPath, { recursive: true, force: true })
      vi.mocked(listWorktrees).mockResolvedValue([])
      await expect(runtime.removeManagedWorktree(worktreeId)).resolves.toEqual({})
      expect(removeWorktreeMeta).toHaveBeenCalledWith(
        hostWorktreeTarget({ id: worktreeId, hostId: 'local' })
      )
    } finally {
      gitSpy.mockRestore()
      await rm(parentDir, { recursive: true, force: true })
    }
  })
})
