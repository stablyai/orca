import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getEffectiveHooksFromConfigMock,
  parseOrcaYamlMock,
  shouldRunSetupForCreateMock,
  resolveSetupRunnerShellMock,
  getSshGitProviderMock,
  getSshFilesystemProviderMock,
  getActiveMultiplexerMock
} from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'

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

describe('registerWorktreeHandlers', () => {
  beforeEach(() => {
    setupWorktreeHandlers()
  })

  it('reads remote orca.yaml and returns a setup launch payload during SSH create', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: 'origin/main'
    }
    const provider = {
      exec: vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'remote') {
          return { stdout: 'origin\n', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args[1] === '--git-path') {
          return {
            stdout: '/remote/repo/.git/worktrees/repo-improve-dashboard/orca/setup-runner.sh\n',
            stderr: ''
          }
        }
        if (args[0] === 'rev-parse') {
          throw new Error('missing local branch')
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo-improve-dashboard',
          head: 'abc123',
          branch: 'refs/heads/improve-dashboard',
          isBare: false,
          isMainWorktree: false
        }
      ])
    }
    const fsProvider = {
      readFile: vi.fn().mockResolvedValue({
        content: 'scripts:\n  setup: pnpm install\n',
        isBinary: false
      }),
      createDir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined)
    }
    const mux = {
      request: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn()
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)
    getActiveMultiplexerMock.mockReturnValue(mux)
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)
    parseOrcaYamlMock.mockReturnValue({ scripts: { setup: 'pnpm install' } })
    getEffectiveHooksFromConfigMock.mockReturnValue({ scripts: { setup: 'pnpm install' } })
    shouldRunSetupForCreateMock.mockReturnValue(true)

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'improve-dashboard',
      setupDecision: 'run'
    })

    expect(fsProvider.readFile).toHaveBeenCalledWith('/remote/repo/orca.yaml')
    expect(fsProvider.readFile).toHaveBeenCalledWith('/remote/repo-improve-dashboard/orca.yaml')
    expect(provider.exec).toHaveBeenCalledWith(
      ['rev-parse', '--git-path', 'orca/setup-runner.sh'],
      '/remote/repo-improve-dashboard'
    )
    expect(fsProvider.createDir).toHaveBeenCalledWith(
      '/remote/repo/.git/worktrees/repo-improve-dashboard/orca'
    )
    expect(fsProvider.writeFile).toHaveBeenCalledWith(
      '/remote/repo/.git/worktrees/repo-improve-dashboard/orca/setup-runner.sh',
      '#!/usr/bin/env bash\nset -e\npnpm install\n'
    )
    expect(result).toEqual(
      expect.objectContaining({
        setup: {
          runnerScriptPath:
            '/remote/repo/.git/worktrees/repo-improve-dashboard/orca/setup-runner.sh',
          envVars: expect.objectContaining({
            ORCA_ROOT_PATH: '/remote/repo',
            ORCA_WORKTREE_PATH: '/remote/repo-improve-dashboard'
          })
        }
      })
    )
  })

  it('keeps Windows SSH setup runners independent from the local Git Bash setting', async () => {
    const repo = {
      id: 'repo-ssh',
      path: 'C:\\remote\\repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: 'origin/main'
    }
    const provider = {
      exec: vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'remote') {
          return { stdout: 'origin\n', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args[1] === '--git-path') {
          return {
            stdout:
              'C:\\remote\\repo\\.git\\worktrees\\improve-dashboard\\orca\\setup-runner.cmd\n',
            stderr: ''
          }
        }
        if (args[0] === 'rev-parse') {
          throw new Error('missing local branch')
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: 'C:\\remote\\improve-dashboard',
          head: 'abc123',
          branch: 'refs/heads/improve-dashboard',
          isBare: false,
          isMainWorktree: false
        }
      ])
    }
    const fsProvider = {
      readFile: vi.fn().mockResolvedValue({
        content: 'scripts:\n  setup: pnpm install\n',
        isBinary: false
      }),
      createDir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined)
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    store.getSettings.mockReturnValue({
      branchPrefix: 'none',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      terminalWindowsShell: 'git-bash',
      workspaceDir: 'C:\\workspace'
    })
    getSshGitProviderMock.mockReturnValue(provider)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)
    getActiveMultiplexerMock.mockReturnValue({
      request: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn()
    })
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)
    parseOrcaYamlMock.mockReturnValue({ scripts: { setup: 'pnpm install' } })
    getEffectiveHooksFromConfigMock.mockReturnValue({ scripts: { setup: 'pnpm install' } })
    shouldRunSetupForCreateMock.mockReturnValue(true)
    resolveSetupRunnerShellMock.mockReturnValue({ family: 'posix' })

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'improve-dashboard',
      setupDecision: 'run'
    })

    expect(provider.exec).toHaveBeenCalledWith(
      ['rev-parse', '--git-path', 'orca/setup-runner.cmd'],
      'C:\\remote\\improve-dashboard'
    )
    expect(fsProvider.writeFile).toHaveBeenCalledWith(
      'C:\\remote\\repo\\.git\\worktrees\\improve-dashboard\\orca\\setup-runner.cmd',
      'pnpm install'
    )
    expect(resolveSetupRunnerShellMock).not.toHaveBeenCalled()
    expect(result).toEqual(
      expect.objectContaining({
        setup: {
          runnerScriptPath:
            'C:\\remote\\repo\\.git\\worktrees\\improve-dashboard\\orca\\setup-runner.cmd',
          envVars: expect.objectContaining({
            ORCA_ROOT_PATH: 'C:\\remote\\repo',
            ORCA_WORKTREE_PATH: 'C:\\remote\\improve-dashboard'
          })
        }
      })
    )
  })

  it('creates sparse checkout metadata and remote sparse config for SSH worktrees', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: 'origin/main'
    }
    const provider = {
      exec: vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'remote') {
          return { stdout: 'origin\n', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo-sparse-dashboard',
          head: 'abc123',
          branch: 'refs/heads/sparse-dashboard',
          isBare: false,
          isSparse: true,
          isMainWorktree: false
        }
      ])
    }
    const mux = {
      request: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn()
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    store.getSparsePresets.mockReturnValue([
      {
        id: 'preset-1',
        repoId: 'repo-ssh',
        name: 'App',
        directories: ['apps/mobile', 'packages/shared'],
        createdAt: 1,
        updatedAt: 1
      }
    ])
    getSshGitProviderMock.mockReturnValue(provider)
    getActiveMultiplexerMock.mockReturnValue(mux)
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'sparse-dashboard',
      sparseCheckout: {
        directories: [' apps/mobile ', 'packages/shared', 'apps/mobile'],
        presetId: 'preset-1'
      }
    })

    expect(provider.addWorktree).toHaveBeenCalledWith(
      '/remote/repo',
      'sparse-dashboard',
      '/remote/repo-sparse-dashboard',
      { base: 'origin/main', noCheckout: true }
    )
    expect(provider.exec).toHaveBeenCalledWith(
      ['sparse-checkout', 'init', '--cone'],
      '/remote/repo-sparse-dashboard'
    )
    expect(provider.exec).toHaveBeenCalledWith(
      ['sparse-checkout', 'set', '--', 'apps/mobile', 'packages/shared'],
      '/remote/repo-sparse-dashboard'
    )
    expect(provider.exec).toHaveBeenCalledWith(
      ['checkout', 'sparse-dashboard'],
      '/remote/repo-sparse-dashboard'
    )
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-ssh::/remote/repo-sparse-dashboard',
      expect.objectContaining({
        sparseDirectories: ['apps/mobile', 'packages/shared'],
        baseRef: 'refs/remotes/origin/main',
        sparseBaseRef: 'refs/remotes/origin/main',
        sparsePresetId: 'preset-1'
      })
    )
    expect(result).toMatchObject({
      worktree: expect.objectContaining({
        isSparse: true,
        sparseDirectories: ['apps/mobile', 'packages/shared'],
        sparseBaseRef: 'refs/remotes/origin/main',
        sparsePresetId: 'preset-1'
      })
    })
  })
})
