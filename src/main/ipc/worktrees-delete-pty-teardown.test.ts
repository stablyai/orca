import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listWorktreesMock,
  assertWorktreeCleanForRemovalMock,
  removeWorktreeMock,
  getEffectiveHooksMock,
  getEffectiveHooksFromConfigMock,
  runHookMock,
  getSshGitProviderMock,
  deleteWorktreeHistoryDirMock,
  killAllProcessesForWorktreeMock,
  clearProviderPtyStateMock,
  getSshPtyProviderMock
} from './worktrees-test-module-mocks'
import { handlers, mainWindow, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { mockKnownFeatureWorktree } from './worktrees-test-fixtures'
import type { WorktreeRuntimeStub } from './worktrees-test-runtime-stub'

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
vi.mock('../hooks', async () => (await import('./worktrees-test-module-mocks')).hooksModuleMock())
vi.mock('../setup-runner-script-text', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupRunnerScriptTextModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../worktree-runner-script', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeRunnerScriptModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../effective-hook-config', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).effectiveHookConfigModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../setup-hook-env-vars', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupHookEnvVarsModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('./worktree-logic', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeLogicModuleMock(
    (await importOriginal()) as Record<string, unknown>
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

describe('registerWorktreeHandlers', () => {
  let runtimeStub: WorktreeRuntimeStub

  beforeEach(() => {
    runtimeStub = setupWorktreeHandlers()
  })

  it('coalesces concurrent deletes for the same worktree id', async () => {
    mockKnownFeatureWorktree()
    deleteWorktreeHistoryDirMock.mockClear()
    let removalStarted!: () => void
    let finishRemoval!: () => void
    const started = new Promise<void>((resolve) => {
      removalStarted = resolve
    })
    removeWorktreeMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          removalStarted()
          finishRemoval = resolve
        })
    )

    const first = handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt',
      force: true
    }) as Promise<unknown>
    const second = handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt',
      hostId: 'local',
      force: true
    }) as Promise<unknown>

    await started
    await Promise.resolve()
    expect(removeWorktreeMock).toHaveBeenCalledTimes(1)

    finishRemoval()
    await expect(Promise.all([first, second])).resolves.toEqual([{}, {}])
    expect(store.removeWorktreeMeta).toHaveBeenCalledTimes(1)
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledTimes(1)
    expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
  })

  it('rejects concurrent deletes for the same worktree id with different options', async () => {
    mockKnownFeatureWorktree()
    let removalStarted!: () => void
    let finishRemoval!: () => void
    const started = new Promise<void>((resolve) => {
      removalStarted = resolve
    })
    removeWorktreeMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          removalStarted()
          finishRemoval = resolve
        })
    )

    const first = handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    }) as Promise<unknown>

    await started
    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: 'repo-1::/workspace/feature-wt',
        hostId: 'local',
        force: true
      })
    ).rejects.toThrow('Worktree deletion already in progress')

    expect(removeWorktreeMock).toHaveBeenCalledTimes(1)
    finishRemoval()
    await expect(first).resolves.toEqual({})
  })

  it('still rejects forced unregistered delete paths that exist on disk', async () => {
    mockKnownFeatureWorktree('/workspace/real-feature')

    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: `repo-1::${process.cwd()}`,
        force: true
      })
    ).rejects.toThrow('Refusing to delete unregistered worktree path')

    expect(killAllProcessesForWorktreeMock).not.toHaveBeenCalled()
    expect(runHookMock).not.toHaveBeenCalled()
    expect(removeWorktreeMock).not.toHaveBeenCalled()
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
  })

  it('rejects the main worktree before teardown, hooks, or git removal', async () => {
    mockKnownFeatureWorktree()

    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: 'repo-1::/workspace/repo'
      })
    ).rejects.toThrow('Refusing to delete protected worktree path')

    expect(killAllProcessesForWorktreeMock).not.toHaveBeenCalled()
    expect(runHookMock).not.toHaveBeenCalled()
    expect(removeWorktreeMock).not.toHaveBeenCalled()
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
  })

  it('rejects deleting a worktree that contains another registered worktree before teardown, hooks, or git removal', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/repo',
        head: 'main',
        branch: 'main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: '/workspace/parent',
        head: 'parent',
        branch: 'parent',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: '/workspace/parent/child',
        head: 'child',
        branch: 'child',
        isBare: false,
        isMainWorktree: false
      }
    ])
    getEffectiveHooksMock.mockReturnValue({
      scripts: {
        archive: 'echo archived'
      }
    })

    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: 'repo-1::/workspace/parent',
        force: true
      })
    ).rejects.toThrow(
      'Refusing to delete worktree because it contains another registered worktree: /workspace/parent/child'
    )

    expect(killAllProcessesForWorktreeMock).not.toHaveBeenCalled()
    expect(runHookMock).not.toHaveBeenCalled()
    expect(removeWorktreeMock).not.toHaveBeenCalled()
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
  })

  it('IPC-initiated delete kills PTYs BEFORE git-level removal (design §4.3)', async () => {
    mockKnownFeatureWorktree()
    getEffectiveHooksMock.mockReturnValue(null)
    const callOrder: string[] = []
    assertWorktreeCleanForRemovalMock.mockImplementation(async () => {
      callOrder.push('preflight')
    })
    killAllProcessesForWorktreeMock.mockImplementation(async () => {
      callOrder.push('kill')
      return { runtimeStopped: 1, providerStopped: 0, registryStopped: 0 }
    })
    removeWorktreeMock.mockImplementation(async () => {
      callOrder.push('git')
    })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })

    expect(killAllProcessesForWorktreeMock).toHaveBeenCalledWith(
      'repo-1::/workspace/feature-wt',
      expect.objectContaining({
        localProvider: expect.anything(),
        onPtyStopped: clearProviderPtyStateMock,
        requirePhysicalStop: true
      })
    )
    expect(removeWorktreeMock).toHaveBeenCalled()
    expect(callOrder).toEqual(['preflight', 'kill', 'git'])
  })

  // Regression: `repoId::path` ids repeat across hosts, so an SSH delete used to reach the
  // runtime's same-id local (or other-connection) terminals and stop them.
  it('fences an SSH worktree delete PTY sweep to the owning connection', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    }
    const sshPtyProvider = { id: 'ssh-pty-provider' } as never
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue({
      listWorktrees: vi.fn().mockResolvedValue([
        { path: '/remote/repo', head: 'main', branch: 'main', isBare: false, isMainWorktree: true },
        {
          path: '/remote/feature-wt',
          head: 'feature',
          branch: 'feature',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      removeWorktree: vi.fn().mockResolvedValue({}),
      worktreeIsClean: vi.fn().mockResolvedValue({ clean: true })
    })
    getSshPtyProviderMock.mockReturnValue(sshPtyProvider)
    getEffectiveHooksFromConfigMock.mockReturnValue(null)

    await handlers['worktrees:remove'](null, { worktreeId: 'repo-ssh::/remote/feature-wt' })

    expect(killAllProcessesForWorktreeMock).toHaveBeenCalledWith('repo-ssh::/remote/feature-wt', {
      runtime: runtimeStub,
      resolvedWorktreeId: 'repo-ssh::/remote/feature-wt',
      resolvedConnectionId: 'conn-1',
      localProvider: sshPtyProvider,
      onPtyStopped: clearProviderPtyStateMock,
      requirePhysicalStop: true,
      includeLocalRegistry: false
    })
  })

  // The local counterpart still identifies itself by exact id so a selector that resolves
  // two hosts can no longer decide which workspace loses its terminals.
  it('pins a local worktree delete PTY sweep to the exact worktree id', async () => {
    mockKnownFeatureWorktree()
    getEffectiveHooksMock.mockReturnValue(null)
    removeWorktreeMock.mockResolvedValue({})

    await handlers['worktrees:remove'](null, { worktreeId: 'repo-1::/workspace/feature-wt' })

    expect(killAllProcessesForWorktreeMock).toHaveBeenCalledWith(
      'repo-1::/workspace/feature-wt',
      expect.objectContaining({ resolvedWorktreeId: 'repo-1::/workspace/feature-wt' })
    )
    expect(killAllProcessesForWorktreeMock).toHaveBeenCalledWith(
      'repo-1::/workspace/feature-wt',
      expect.not.objectContaining({ resolvedConnectionId: expect.anything() })
    )
  })

  // Why (#11960): the PTY gate previously had no escape hatch at all, so a
  // workspace with an unprovable PTY was unremovable forever.
  it('forwards an explicit Force Delete to the PTY gate', async () => {
    mockKnownFeatureWorktree()
    getEffectiveHooksMock.mockReturnValue(null)

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt',
      force: true,
      allowUnverifiedPtyStop: true
    })

    expect(killAllProcessesForWorktreeMock).toHaveBeenCalledWith(
      'repo-1::/workspace/feature-wt',
      expect.objectContaining({ requirePhysicalStop: true, allowUnverifiedStop: true })
    )
  })

  // Why (#11960): the ordinary Delete confirmation already sets force:true to skip
  // the dirty-file prompt. Waiving PTY-stop proof off that signal would silently
  // disable the gate on the primary delete path.
  it('keeps the PTY gate strict for a confirmed delete that only sets force', async () => {
    mockKnownFeatureWorktree()
    getEffectiveHooksMock.mockReturnValue(null)

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt',
      force: true
    })

    expect(killAllProcessesForWorktreeMock).toHaveBeenCalledWith(
      'repo-1::/workspace/feature-wt',
      expect.not.objectContaining({ allowUnverifiedStop: true })
    )
  })

  it('keeps the PTY gate strict for a plain delete', async () => {
    mockKnownFeatureWorktree()
    getEffectiveHooksMock.mockReturnValue(null)

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })

    expect(killAllProcessesForWorktreeMock).toHaveBeenCalledWith(
      'repo-1::/workspace/feature-wt',
      expect.not.objectContaining({ allowUnverifiedStop: true })
    )
  })

  it('does not start Git removal when physical PTY teardown cannot be proven', async () => {
    mockKnownFeatureWorktree()
    getEffectiveHooksMock.mockReturnValue(null)
    killAllProcessesForWorktreeMock.mockRejectedValueOnce(
      new Error('Timed out waiting for physical PTY teardown')
    )

    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: 'repo-1::/workspace/feature-wt'
      })
    ).rejects.toThrow('Timed out waiting for physical PTY teardown')

    expect(removeWorktreeMock).not.toHaveBeenCalled()
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
  })
})
