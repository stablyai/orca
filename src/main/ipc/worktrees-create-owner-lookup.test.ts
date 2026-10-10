import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addWorktreeMock,
  createSetupRunnerScriptMock,
  getSshGitProviderMock
} from './worktrees-test-module-mocks'
import { handlers, mainWindow, setupWorktreeHandlers, store } from './worktrees-test-harness'

vi.mock('electron', async () =>
  (await import('./worktrees-test-module-mocks')).electronModuleMock()
)
vi.mock('../git/worktree', async () =>
  (await import('./worktrees-test-module-mocks')).gitWorktreeModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./worktrees-test-module-mocks')).gitRunnerModuleMock()
)
vi.mock('../git/repo', async () =>
  (await import('./worktrees-test-module-mocks')).gitRepoModuleMock()
)
vi.mock('../git/git-username', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveLocalGitUsername: (await import('./worktrees-test-module-mocks'))
    .resolveLocalGitUsernameMock
}))
vi.mock('../github/client', async () =>
  (await import('./worktrees-test-module-mocks')).githubClientModuleMock()
)
vi.mock('../source-control/hosted-review', async () =>
  (await import('./worktrees-test-module-mocks')).hostedReviewModuleMock()
)
vi.mock('../providers/ssh-git-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshGitDispatchModuleMock()
)
vi.mock('../providers/ssh-filesystem-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshFilesystemDispatchModuleMock()
)
vi.mock('./worktree-symlinks', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeSymlinksModuleMock()
)
vi.mock('./ssh', async () => (await import('./worktrees-test-module-mocks')).sshModuleMock())
vi.mock('../ssh/ssh-target-registry', async () =>
  (await import('./worktrees-test-module-mocks')).sshTargetRegistryModuleMock()
)
vi.mock('../hooks', async () => (await import('./worktrees-test-module-mocks')).hooksModuleMock())
vi.mock('../setup-runner-script-text', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupRunnerScriptTextModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('../worktree-runner-script', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeRunnerScriptModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('../effective-hook-config', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).effectiveHookConfigModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('../setup-hook-env-vars', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupHookEnvVarsModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('./worktree-logic', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeLogicModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('../terminal-history-deletion', async () =>
  (await import('./worktrees-test-module-mocks')).terminalHistoryDeletionModuleMock()
)
vi.mock('../ports/advertised-url-watcher', async () =>
  (await import('./worktrees-test-module-mocks')).advertisedUrlWatcherModuleMock()
)
vi.mock('../workspace-cleanup-scan-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupScanSnapshotModuleMock()
)
vi.mock('../workspace-space-analysis-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceSpaceAnalysisSnapshotModuleMock()
)
vi.mock('../workspace-cleanup-removal-snapshot-prune', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupRemovalSnapshotPruneModuleMock()
)
vi.mock('../runtime/worktree-teardown', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeTeardownModuleMock()
)
vi.mock('./pty', async () => (await import('./worktrees-test-module-mocks')).ptyModuleMock())

import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'
import type { WorktreeRuntimeStub } from './worktrees-test-runtime-stub'

function folderRepo(id: string, fields: Partial<Repo> = {}): Repo {
  return {
    id,
    path: '/receiver/folder',
    displayName: 'Folder',
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'folder',
    ...fields
  }
}

function setCatalog(repos: Repo[]): void {
  store.getRepos.mockReturnValue(repos)
  store.getRepo.mockImplementation((id) => repos.find((repo) => repo.id === id))
  store.getProjectHostSetups.mockReturnValue(
    repos.map((repo) => ({
      id: repo.id,
      repoId: repo.id,
      projectId: 'project:shared',
      hostId: repo.executionHostId ?? 'local',
      path: repo.path,
      displayName: repo.displayName,
      setupState: 'ready',
      setupMethod: 'legacy-repo',
      createdAt: 1,
      updatedAt: 1
    }))
  )
  store.setWorktreeMeta.mockImplementation((_id, meta) => meta)
}

function expectNoCreationEffects(runtime: WorktreeRuntimeStub): void {
  expect(store.setWorktreeMeta).not.toHaveBeenCalled()
  expect(store.setWorktreeMetaForHost).not.toHaveBeenCalled()
  expect(addWorktreeMock).not.toHaveBeenCalled()
  expect(getSshGitProviderMock).not.toHaveBeenCalled()
  expect(createSetupRunnerScriptMock).not.toHaveBeenCalled()
  expect(runtime.createTerminal).not.toHaveBeenCalled()
  expect(mainWindow.webContents.send).not.toHaveBeenCalled()
}

describe('registered worktrees:create repository lookup', () => {
  let runtime: WorktreeRuntimeStub

  beforeEach(() => {
    runtime = setupWorktreeHandlers()
  })

  it.each(['name:opaque', 'path:/opaque', 'id:opaque'])(
    'treats %s as an exact opaque repo ID',
    async (id) => {
      setCatalog([
        folderRepo(id),
        folderRepo('other', { path: '/other', displayName: id.slice(id.indexOf(':') + 1) })
      ])

      const result = await handlers['worktrees:create'](null, { repoId: id, name: 'Workspace' })

      expect(runtime.showRepo).toHaveBeenCalledWith(`id:${id}`)
      expect(result).toMatchObject({ worktree: { repoId: id, path: '/receiver/folder' } })
      expect(store.setWorktreeMeta).toHaveBeenCalledTimes(1)
      expect(addWorktreeMock).not.toHaveBeenCalled()
    }
  )

  it('maps only a missing repository to the existing IPC error before creation effects', async () => {
    setCatalog([])

    await expect(
      handlers['worktrees:create'](null, { repoId: 'missing', name: 'Workspace' })
    ).rejects.toThrow('Repo not found: missing')

    expect(runtime.showRepo).toHaveBeenCalledWith('id:missing')
    expectNoCreationEffects(runtime)
  })

  it.each([false, true])(
    'refuses duplicate unqualified owners with reverse=%s',
    async (reverse) => {
      const a = folderRepo('shared', { executionHostId: 'ssh:a', path: '/receiver/a' })
      const b = folderRepo('shared', { executionHostId: 'ssh:b', path: '/receiver/b' })
      setCatalog(reverse ? [b, a] : [a, b])

      await expect(
        handlers['worktrees:create'](null, { repoId: 'shared', name: 'Workspace' })
      ).rejects.toThrow('selector_ambiguous')

      expectNoCreationEffects(runtime)
    }
  )

  it.each(['local', 'runtime:paired'] as const)(
    'retains strict %s qualifier refusal for contradictory legacy ownership',
    async (executionHostId) => {
      setCatalog([folderRepo('legacy', { executionHostId, connectionId: 'surviving' })])

      await expect(
        handlers['worktrees:create'](null, {
          repoId: 'legacy',
          name: 'Workspace',
          executionHostId
        })
      ).rejects.toThrow('Repo not found: legacy')

      expect(runtime.showRepo).not.toHaveBeenCalled()
      expectNoCreationEffects(runtime)
    }
  )

  it.each([false, true])('creates only the qualified sibling with reverse=%s', async (reverse) => {
    const a = folderRepo('shared', { executionHostId: 'ssh:a', path: '/receiver/a' })
    const b = folderRepo('shared', { executionHostId: 'ssh:b', path: '/receiver/b' })
    setCatalog(reverse ? [b, a] : [a, b])

    const result = await handlers['worktrees:create'](null, {
      repoId: 'shared',
      name: 'Workspace',
      executionHostId: 'ssh:b'
    })

    expect(runtime.showRepo).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      worktree: {
        repoId: 'shared',
        path: '/receiver/b',
        hostId: 'ssh:b'
      } satisfies Partial<Worktree>
    })
    expect(store.setWorktreeMeta).toHaveBeenCalledTimes(1)
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      expect.stringContaining('shared::/receiver/b'),
      expect.objectContaining({ hostId: 'ssh:b' })
    )
    expect(addWorktreeMock).not.toHaveBeenCalled()
    expect(getSshGitProviderMock).not.toHaveBeenCalled()
  })

  it('preserves other runtime selector errors before creation effects', async () => {
    setCatalog([folderRepo('legacy')])
    runtime.showRepo.mockRejectedValueOnce(new Error('runtime_unavailable'))

    await expect(
      handlers['worktrees:create'](null, { repoId: 'legacy', name: 'Workspace' })
    ).rejects.toThrow('runtime_unavailable')

    expectNoCreationEffects(runtime)
  })

  it('keeps provisioned-root adoption on the strict owner lookup', async () => {
    setCatalog([
      folderRepo('legacy', { kind: 'git', executionHostId: 'local', connectionId: 'surviving' })
    ])

    await expect(
      handlers['worktrees:adoptProvisionedRoot'](null, { repoId: 'legacy', name: 'Workspace' })
    ).rejects.toThrow('Provisioned-root repository ownership is missing or ambiguous.')

    expect(runtime.showRepo).not.toHaveBeenCalled()
    expectNoCreationEffects(runtime)
  })
})
