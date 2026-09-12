import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  removeWorktreeLinkedPathsMock,
  findExistingWorktreeSymlinkPathsMock,
  assertWorktreeCleanForRemovalMock,
  removeWorktreeMock,
  getEffectiveHooksMock,
  getEffectiveHooksFromConfigMock,
  runHookMock,
  loadHooksMock,
  getSshGitProviderMock,
  getSshFilesystemProviderMock,
  killAllProcessesForWorktreeMock
} from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { mockKnownFeatureWorktree } from './worktrees-test-fixtures'
import {
  ARCHIVE_HOOK_FAILED_REMOVAL_CODE,
  WorktreeArchiveHookFailedError
} from '../../shared/worktree/archive-hook-removal-gate'
import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import type { RemoveWorktreeArgs } from './worktrees/ipc-context-schemas'
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
vi.mock('../ssh/ssh-target-registry', async () =>
  (await import('./worktrees-test-module-mocks')).sshTargetRegistryModuleMock()
)
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

// The shared IPC surface types every handler as returning `unknown`; removal's contract is
// narrower, and #19334's whole point is that a caller can name and branch on it.
async function removeWorktreeViaIpc(args: RemoveWorktreeArgs): Promise<RemoveWorktreeResult> {
  return (await handlers['worktrees:remove'](null, args)) as RemoveWorktreeResult
}

/** Narrows through the exported error class — the same branch a real caller would write. */
async function expectArchiveHookRefusal(
  args: RemoveWorktreeArgs
): Promise<WorktreeArchiveHookFailedError> {
  try {
    await removeWorktreeViaIpc(args)
  } catch (error) {
    if (error instanceof WorktreeArchiveHookFailedError) {
      return error
    }
    throw error
  }
  throw new Error(`expected removal of ${args.worktreeId} to be refused by the archive hook`)
}

describe('registerWorktreeHandlers', () => {
  let runtimeStub: WorktreeRuntimeStub

  beforeEach(() => {
    runtimeStub = setupWorktreeHandlers()
  })

  it('runs the archive hook on remove when skipArchive is not set', async () => {
    mockKnownFeatureWorktree()
    removeWorktreeMock.mockResolvedValue(undefined)
    getEffectiveHooksMock.mockReturnValue({
      scripts: {
        archive: 'echo archived'
      }
    })
    runHookMock.mockResolvedValue({ success: true, output: '' })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })

    expect(runHookMock).toHaveBeenCalledWith(
      'archive',
      '/workspace/feature-wt',
      expect.objectContaining({ id: 'repo-1' }),
      undefined,
      {}
    )
    expect(removeWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/feature-wt',
      false,
      expect.objectContaining({
        knownRemovedWorktree: expect.objectContaining({
          branch: 'feature',
          head: 'feature',
          path: '/workspace/feature-wt'
        })
      })
    )
  })

  it('passes project shared links through the IPC removal preflight and cleanup', async () => {
    mockKnownFeatureWorktree()
    loadHooksMock.mockReturnValue({
      worktree: { sharedDirectories: ['node_modules'] }
    })
    findExistingWorktreeSymlinkPathsMock.mockResolvedValue(['node_modules'])
    removeWorktreeMock.mockResolvedValue({})

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })

    expect(findExistingWorktreeSymlinkPathsMock).toHaveBeenCalledWith('/workspace/feature-wt', [
      'node_modules'
    ])
    expect(assertWorktreeCleanForRemovalMock).toHaveBeenCalledWith('/workspace/feature-wt', false, {
      ignoredUntrackedPaths: ['node_modules']
    })
    expect(removeWorktreeLinkedPathsMock).toHaveBeenCalledWith('/workspace/feature-wt', [
      'node_modules'
    ])
    // Why order matters: linked-path deletion is destructive, so PTYs must release every handle
    // before Windows or WSL filesystem cleanup starts (mirrors the runtime removal path).
    expect(killAllProcessesForWorktreeMock).toHaveBeenCalled()
    // Latest PTY sweep vs earliest deletion: a later sweep would mean handles were still open.
    expect(Math.max(...killAllProcessesForWorktreeMock.mock.invocationCallOrder)).toBeLessThan(
      Math.min(...removeWorktreeLinkedPathsMock.mock.invocationCallOrder)
    )
  })

  it('does not remove a worktree when watcher teardown cannot release it', async () => {
    mockKnownFeatureWorktree()
    store.getRepo.mockReturnValue({
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      symlinkPaths: ['node_modules']
    })
    runtimeStub.closeFileWatchersForRemoval.mockRejectedValue(
      new Error('file watcher process did not exit after termination deadline')
    )

    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: 'repo-1::/workspace/feature-wt'
      })
    ).rejects.toThrow('file watcher process did not exit after termination deadline')

    expect(removeWorktreeMock).not.toHaveBeenCalled()
    expect(removeWorktreeLinkedPathsMock).not.toHaveBeenCalled()
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
  })

  it('releases the watcher-install fence when worktree deletion fails', async () => {
    mockKnownFeatureWorktree()
    const finish = vi.fn().mockResolvedValue(undefined)
    runtimeStub.acquireFileWatcherRemoval.mockResolvedValueOnce({
      finish
    })
    removeWorktreeMock.mockRejectedValueOnce(new Error('delete failed'))

    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: 'repo-1::/workspace/feature-wt'
      })
    ).rejects.toThrow('delete failed')

    expect(finish).toHaveBeenCalledWith(false)
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
  })

  it('skips the archive hook on remove when skipArchive is true', async () => {
    mockKnownFeatureWorktree()
    removeWorktreeMock.mockResolvedValue(undefined)
    getEffectiveHooksMock.mockReturnValue({
      scripts: {
        archive: 'echo archived'
      }
    })
    runHookMock.mockResolvedValue({ success: true, output: '' })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt',
      skipArchive: true
    })

    expect(runHookMock).not.toHaveBeenCalled()
    expect(removeWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/feature-wt',
      false,
      expect.objectContaining({
        knownRemovedWorktree: expect.objectContaining({
          branch: 'feature',
          head: 'feature',
          path: '/workspace/feature-wt'
        })
      })
    )
  })

  it('runs the archive hook before removing an SSH worktree', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    }
    const callOrder: string[] = []
    runtimeStub.closeFileWatchersForRemoval.mockImplementationOnce(async () => {
      callOrder.push('watchers')
    })
    const provider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'main',
          branch: 'main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/remote/feature-wt',
          head: 'feature',
          branch: 'feature',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      removeWorktree: vi.fn().mockImplementation(async () => {
        callOrder.push('remove')
      }),
      worktreeIsClean: vi.fn().mockImplementation(async () => {
        callOrder.push('preflight')
        return { clean: true }
      }),
      execNonInteractive: vi.fn().mockImplementation(async () => {
        callOrder.push('archive')
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false }
      })
    }
    const fsProvider = {
      readFile: vi.fn().mockResolvedValue({
        content: 'scripts:\n  archive: echo archived\n',
        isBinary: false
      })
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)
    getEffectiveHooksFromConfigMock.mockReturnValue({ scripts: { archive: 'echo archived' } })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-ssh::/remote/feature-wt'
    })

    expect(fsProvider.readFile).toHaveBeenCalledWith('/remote/repo/orca.yaml')
    expect(provider.execNonInteractive).toHaveBeenCalledWith(
      '/bin/bash',
      ['-lc', 'echo archived'],
      '/remote/feature-wt',
      120_000,
      undefined,
      expect.objectContaining({
        ORCA_ROOT_PATH: '/remote/repo',
        ORCA_WORKTREE_PATH: '/remote/feature-wt'
      })
    )
    expect(provider.removeWorktree).toHaveBeenCalledWith('/remote/feature-wt', undefined)
    expect(runtimeStub.closeFileWatchersForRemoval).toHaveBeenCalledWith(
      '/remote/feature-wt',
      'conn-1'
    )
    expect(callOrder).toEqual(['archive', 'preflight', 'watchers', 'remove'])
    expect(runHookMock).not.toHaveBeenCalled()
  })

  it('runs SSH archive hooks before failing dirty non-force removal', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    }
    const callOrder: string[] = []
    const provider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'main',
          branch: 'main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/remote/feature-wt',
          head: 'feature',
          branch: 'feature',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      removeWorktree: vi.fn().mockImplementation(async () => {
        callOrder.push('remove')
      }),
      worktreeIsClean: vi.fn().mockImplementation(async () => {
        callOrder.push('preflight')
        return { clean: false, stdout: ' M src/file.ts\n?? scratch.txt\n' }
      }),
      execNonInteractive: vi.fn().mockImplementation(async () => {
        callOrder.push('archive')
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false }
      })
    }
    const fsProvider = {
      readFile: vi.fn().mockResolvedValue({
        content: 'scripts:\n  archive: echo archived\n',
        isBinary: false
      })
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)
    getEffectiveHooksFromConfigMock.mockReturnValue({ scripts: { archive: 'echo archived' } })

    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: 'repo-ssh::/remote/feature-wt'
      })
    ).rejects.toThrow('Worktree has uncommitted or untracked changes.')

    expect(callOrder).toEqual(['archive', 'preflight'])
    expect(provider.removeWorktree).not.toHaveBeenCalled()
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
  })

  it('skips SSH dirty preflight for force removal', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    }
    const provider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'main',
          branch: 'main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/remote/feature-wt',
          head: 'feature',
          branch: 'feature',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      worktreeIsClean: vi.fn(),
      execNonInteractive: vi.fn().mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false
      })
    }
    const fsProvider = {
      readFile: vi.fn().mockResolvedValue({
        content: 'scripts:\n  archive: echo archived\n',
        isBinary: false
      })
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)
    getEffectiveHooksFromConfigMock.mockReturnValue({ scripts: { archive: 'echo archived' } })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-ssh::/remote/feature-wt',
      force: true
    })

    expect(provider.worktreeIsClean).not.toHaveBeenCalled()
    expect(provider.removeWorktree).toHaveBeenCalledWith('/remote/feature-wt', true)
  })

  // Was "continues SSH worktree removal when the archive hook fails" (#19334): it now refuses.
  it('refuses SSH worktree removal when the remote archive hook exits non-zero', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    }
    const provider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'main',
          branch: 'main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/remote/feature-wt',
          head: 'feature',
          branch: 'feature',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      worktreeIsClean: vi.fn().mockResolvedValue({ clean: true }),
      execNonInteractive: vi.fn().mockResolvedValue({
        stdout: '',
        stderr: 'cleanup failed',
        exitCode: 7,
        timedOut: false
      })
    }
    const fsProvider = {
      readFile: vi.fn().mockResolvedValue({
        content: 'scripts:\n  archive: exit 7\n',
        isBinary: false
      })
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)
    getEffectiveHooksFromConfigMock.mockReturnValue({ scripts: { archive: 'exit 7' } })

    const refusal = await expectArchiveHookRefusal({
      worktreeId: 'repo-ssh::/remote/feature-wt'
    })

    expect(refusal.code).toBe(ARCHIVE_HOOK_FAILED_REMOVAL_CODE)
    expect(refusal.data).toMatchObject({ outcome: 'exited', exitCode: 7 })
    expect(provider.worktreeIsClean).not.toHaveBeenCalled()
    expect(provider.removeWorktree).not.toHaveBeenCalled()
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
  })

  it('does not read a lost SSH connection as an archive hook that passed', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    }
    const provider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'main',
          branch: 'main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/remote/feature-wt',
          head: 'feature',
          branch: 'feature',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      worktreeIsClean: vi.fn().mockResolvedValue({ clean: true }),
      execNonInteractive: vi.fn().mockRejectedValue(new Error('relay disconnected'))
    }
    const fsProvider = {
      readFile: vi.fn().mockResolvedValue({
        content: 'scripts:\n  archive: echo archived\n',
        isBinary: false
      })
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)
    getEffectiveHooksFromConfigMock.mockReturnValue({ scripts: { archive: 'echo archived' } })

    const refusal = await expectArchiveHookRefusal({
      worktreeId: 'repo-ssh::/remote/feature-wt'
    })

    // Loss of contact is `unverifiable`, never evidence the hook succeeded.
    expect(refusal.data).toMatchObject({ outcome: 'unverifiable' })
    expect(refusal.data.exitCode).toBeUndefined()
    expect(provider.removeWorktree).not.toHaveBeenCalled()
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
  })

  it('uses cmd.exe for archive hooks on Windows-like SSH worktree paths', async () => {
    const repo = {
      id: 'repo-ssh',
      path: 'C:\\remote\\repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    }
    const provider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: 'C:\\remote\\repo',
          head: 'main',
          branch: 'main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: 'C:\\remote\\feature-wt',
          head: 'feature',
          branch: 'feature',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      worktreeIsClean: vi.fn().mockResolvedValue({ clean: true }),
      execNonInteractive: vi.fn().mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false
      })
    }
    const fsProvider = {
      readFile: vi.fn().mockResolvedValue({
        content: 'scripts:\n  archive: echo archived\n',
        isBinary: false
      })
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)
    getEffectiveHooksFromConfigMock.mockReturnValue({ scripts: { archive: 'echo archived' } })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-ssh::C:\\remote\\feature-wt'
    })

    expect(fsProvider.readFile).toHaveBeenCalledWith('C:\\remote\\repo\\orca.yaml')
    expect(provider.execNonInteractive).toHaveBeenCalledWith(
      'cmd.exe',
      ['/d', '/s', '/c', 'echo archived'],
      'C:\\remote\\feature-wt',
      120_000,
      undefined,
      expect.objectContaining({
        ORCA_ROOT_PATH: 'C:\\remote\\repo',
        ORCA_WORKTREE_PATH: 'C:\\remote\\feature-wt'
      })
    )
  })

  it('skips the archive hook before removing an SSH worktree when skipArchive is true', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    }
    const provider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'main',
          branch: 'main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/remote/feature-wt',
          head: 'feature',
          branch: 'feature',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      worktreeIsClean: vi.fn().mockResolvedValue({ clean: true }),
      execNonInteractive: vi.fn()
    }
    const fsProvider = {
      readFile: vi.fn().mockResolvedValue({
        content: 'scripts:\n  archive: echo archived\n',
        isBinary: false
      })
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)
    getEffectiveHooksFromConfigMock.mockReturnValue({ scripts: { archive: 'echo archived' } })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-ssh::/remote/feature-wt',
      skipArchive: true
    })

    expect(provider.execNonInteractive).not.toHaveBeenCalled()
    expect(provider.removeWorktree).toHaveBeenCalledWith('/remote/feature-wt', undefined)
  })

  // Regression cover for #19334: a failed archive hook is a blocking precondition, not an advisory.
  it('refuses removal and mutates nothing when the local archive hook exits 23', async () => {
    mockKnownFeatureWorktree()
    removeWorktreeMock.mockResolvedValue(undefined)
    getEffectiveHooksMock.mockReturnValue({
      scripts: { archive: 'echo archived' }
    })
    runHookMock.mockResolvedValue({
      success: false,
      output: 'backup target unreachable',
      exitCode: 23
    })

    const refusal = await expectArchiveHookRefusal({
      worktreeId: 'repo-1::/workspace/feature-wt'
    })

    expect(refusal.code).toBe(ARCHIVE_HOOK_FAILED_REMOVAL_CODE)
    expect(refusal.data).toEqual({
      worktreePath: '/workspace/feature-wt',
      outcome: 'exited',
      exitCode: 23,
      output: 'backup target unreachable'
    })
    expect(killAllProcessesForWorktreeMock).not.toHaveBeenCalled()
    expect(assertWorktreeCleanForRemovalMock).not.toHaveBeenCalled()
    expect(removeWorktreeMock).not.toHaveBeenCalled()
    expect(removeWorktreeLinkedPathsMock).not.toHaveBeenCalled()
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
  })

  it('classifies a local archive hook that never reported an exit as unverifiable', async () => {
    mockKnownFeatureWorktree()
    getEffectiveHooksMock.mockReturnValue({
      scripts: { archive: 'echo archived' }
    })
    runHookMock.mockResolvedValue({
      success: false,
      output: 'Hook timed out after 120000ms.'
    })

    const refusal = await expectArchiveHookRefusal({
      worktreeId: 'repo-1::/workspace/feature-wt'
    })

    expect(refusal.data).toEqual({
      worktreePath: '/workspace/feature-wt',
      outcome: 'unverifiable',
      output: 'Hook timed out after 120000ms.'
    })
    expect(removeWorktreeMock).not.toHaveBeenCalled()
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
  })

  it('removes and records the waiver when a failed archive hook is explicitly overridden', async () => {
    mockKnownFeatureWorktree()
    removeWorktreeMock.mockResolvedValue({})
    getEffectiveHooksMock.mockReturnValue({
      scripts: { archive: 'echo archived' }
    })
    runHookMock.mockResolvedValue({
      success: false,
      output: 'boom',
      exitCode: 23
    })

    const result = await removeWorktreeViaIpc({
      worktreeId: 'repo-1::/workspace/feature-wt',
      allowFailedArchiveHook: true
    })

    expect(result.archiveHookOverride).toEqual({
      worktreePath: '/workspace/feature-wt',
      outcome: 'exited',
      exitCode: 23,
      output: 'boom',
      overridden: true
    })
    expect(removeWorktreeMock).toHaveBeenCalled()
  })

  // The folder-workspace path runs no archive hook at all (no Git removal step), so the gate has
  // nothing to evaluate there. Pinned so a future hook added to that path is a deliberate change.
  it('removes a folder workspace without consulting the archive hook', async () => {
    const repo = {
      id: 'repo-folder',
      path: '/workspace/folder-project',
      displayName: 'folder',
      badgeColor: '#000',
      addedAt: 0,
      kind: 'folder' as const,
      worktreeBaseRef: null
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getEffectiveHooksMock.mockReturnValue({ scripts: { archive: 'exit 23' } })
    runHookMock.mockResolvedValue({
      success: false,
      output: 'boom',
      exitCode: 23
    })

    const result = await removeWorktreeViaIpc({
      worktreeId: 'repo-folder::/workspace/folder-project/nested'
    })

    expect(result).toEqual({})
    expect(runHookMock).not.toHaveBeenCalled()
    expect(removeWorktreeMock).not.toHaveBeenCalled()
    expect(store.removeWorktreeMeta).toHaveBeenCalled()
  })
})
