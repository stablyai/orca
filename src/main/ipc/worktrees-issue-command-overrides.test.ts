import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as issueCommandFile from '../issue-command-file'
import * as projectGitOptions from '../project-runtime-git-options'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createIssueCommandRunnerScriptMock,
  getSshFilesystemProviderMock,
  getSshGitProviderMock,
  parseOrcaYamlMock
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

  it.each(['command', ' '])(
    'preserves local file writes with an unavailable runtime: %j',
    async (content) => {
      const root = mkdtempSync(join(tmpdir(), 'orca-runtime-ignore-'))
      const repo = {
        id: 'repo-1',
        path: root,
        displayName: 'local',
        badgeColor: '#000',
        addedAt: 0
      }
      mkdirSync(join(root, '.orca'))
      writeFileSync(join(root, '.orca', 'issue-command'), 'old command\n')
      store.getRepo.mockReturnValue(repo)
      store.getRepos.mockReturnValue([repo])
      const resolver = vi
        .spyOn(projectGitOptions, 'getLocalProjectWorktreeGitOptions')
        .mockImplementation(() => {
          throw new Error('Project runtime requires repair')
        })
      try {
        await handlers['hooks:writeIssueCommand'](null, { repoId: repo.id, content })
        if (content.trim()) {
          expect(readFileSync(join(root, '.orca', 'issue-command'), 'utf8')).toBe('command\n')
          expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('.orca\n')
        } else {
          expect(existsSync(join(root, '.orca', 'issue-command'))).toBe(false)
          expect(existsSync(join(root, '.gitignore'))).toBe(false)
          expect(resolver).not.toHaveBeenCalled()
        }
      } finally {
        resolver.mockRestore()
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it('forwards the resolved WSL options when writing a local override', async () => {
    const resolveOptions = vi
      .spyOn(projectGitOptions, 'getLocalProjectWorktreeGitOptions')
      .mockReturnValue({ wslDistro: 'Ubuntu' })
    const write = vi.spyOn(issueCommandFile, 'writeIssueCommand').mockResolvedValue(undefined)
    try {
      await handlers['hooks:writeIssueCommand'](null, { repoId: 'repo-1', content: 'command' })
      const options = write.mock.calls[0]?.[2]
      expect(typeof options).toBe('function')
      expect(typeof options === 'function' ? options() : options).toEqual({ wslDistro: 'Ubuntu' })
      expect(resolveOptions).toHaveBeenCalledWith(store, expect.objectContaining({ id: 'repo-1' }))
      expect(write).toHaveBeenCalledExactlyOnceWith(
        '/workspace/repo',
        'command',
        expect.any(Function),
        'issue'
      )
    } finally {
      resolveOptions.mockRestore()
      write.mockRestore()
    }
  })

  it('creates an issue-command runner for an existing repo/worktree pair', async () => {
    const result = await handlers['hooks:createIssueCommandRunner'](null, {
      repoId: 'repo-1',
      worktreePath: '/workspace/improve-dashboard',
      command: 'codex exec "long command"'
    })

    expect(createIssueCommandRunnerScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1' }),
      '/workspace/improve-dashboard',
      'codex exec "long command"',
      {},
      // Why: issue runners take the resolved setup shell; it is undefined off Windows.
      undefined
    )
    expect(result).toMatchObject({
      runnerScriptPath: '/workspace/repo/.git/orca/issue-command-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/workspace/repo',
        ORCA_WORKTREE_PATH: '/workspace/improve-dashboard'
      }
    })
  })

  it('keeps SSH issue-command local overrides usable when shared read fails', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    }
    const fsProvider = {
      readFile: vi.fn(async (filePath: string) => {
        if (filePath.endsWith('/.orca/issue-command')) {
          return { content: 'local command\n', isBinary: false }
        }
        throw new Error('shared read failed')
      })
    }
    store.getRepo.mockReturnValue(repo)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)

    await expect(
      handlers['hooks:readIssueCommand'](null, {
        repoId: 'repo-ssh'
      })
    ).resolves.toMatchObject({
      status: 'ok',
      localContent: 'local command',
      sharedContent: null,
      effectiveContent: 'local command',
      source: 'local'
    })
  })

  it('writes SSH issue-command overrides without clobbering .gitignore on read failure', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    }
    const fsProvider = {
      createDir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockRejectedValue(new Error('ssh read failed')),
      writeFile: vi.fn().mockResolvedValue(undefined),
      deletePath: vi.fn().mockResolvedValue(undefined)
    }
    store.getRepo.mockReturnValue(repo)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)

    await expect(
      handlers['hooks:writeIssueCommand'](null, {
        repoId: 'repo-ssh',
        content: 'orca issue command'
      })
    ).rejects.toThrow('ssh read failed')

    expect(fsProvider.writeFile).not.toHaveBeenCalled()
  })

  it('reads an issue-command override from the requested host when repo ids collide', async () => {
    const localRepo = {
      id: 'repo-shared',
      path: '/local/repo',
      displayName: 'local',
      badgeColor: '#000',
      addedAt: 0
    }
    const sshRepo = {
      ...localRepo,
      path: '/remote/repo',
      displayName: 'ssh',
      connectionId: 'conn-1'
    }
    const fsProvider = {
      readFile: vi.fn(async (filePath: string) => {
        if (filePath.endsWith('/.orca/issue-command')) {
          return { content: 'remote command\n', isBinary: false }
        }
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      })
    }
    store.getRepos.mockReturnValue([localRepo, sshRepo])
    store.getRepo.mockReturnValue(localRepo)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)

    await expect(
      handlers['hooks:readIssueCommand'](null, {
        repoId: 'repo-shared',
        hostId: 'ssh:conn-1'
      })
    ).resolves.toMatchObject({
      localContent: 'remote command',
      effectiveContent: 'remote command',
      source: 'local'
    })
    expect(fsProvider.readFile).toHaveBeenCalledWith('/remote/repo/.orca/issue-command')
  })

  it('creates remote .gitignore only when it is missing while writing SSH issue commands', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    }
    const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' })
    const fsProvider = {
      createDir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockRejectedValue(enoent),
      writeFile: vi.fn().mockResolvedValue(undefined),
      deletePath: vi.fn().mockResolvedValue(undefined)
    }
    store.getRepo.mockReturnValue(repo)
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)

    await handlers['hooks:writeIssueCommand'](null, {
      repoId: 'repo-ssh',
      content: 'orca issue command'
    })

    expect(fsProvider.writeFile).toHaveBeenNthCalledWith(1, '/remote/repo/.gitignore', '.orca\n')
    expect(fsProvider.writeFile).toHaveBeenNthCalledWith(
      2,
      '/remote/repo/.orca/issue-command',
      'orca issue command\n'
    )
  })

  it('rejects SSH issue-command writes when the remote filesystem provider is unavailable', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    }
    store.getRepo.mockReturnValue(repo)
    getSshFilesystemProviderMock.mockReturnValue(null)

    await expect(
      handlers['hooks:writeIssueCommand'](null, {
        repoId: 'repo-ssh',
        content: 'orca issue command'
      })
    ).rejects.toThrow('Remote filesystem unavailable')
  })

  it('preserves .gitignore when the SSH host already ignores .orca', async () => {
    store.getRepo.mockReturnValue({
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1'
    })
    const checkIgnoredPaths = vi.fn().mockResolvedValue(['.orca/issue-command'])
    getSshGitProviderMock.mockReturnValue({ checkIgnoredPaths })
    const fsProvider = {
      createDir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn(),
      writeFile: vi.fn().mockResolvedValue(undefined)
    }
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)

    await handlers['hooks:writeIssueCommand'](null, {
      repoId: 'repo-ssh',
      content: 'local command'
    })

    expect(getSshGitProviderMock).toHaveBeenCalledWith('conn-1')
    expect(checkIgnoredPaths).toHaveBeenCalledWith('/remote/repo', ['.orca/issue-command'])
    expect(fsProvider.readFile).not.toHaveBeenCalled()
    expect(fsProvider.writeFile).toHaveBeenCalledExactlyOnceWith(
      '/remote/repo/.orca/issue-command',
      'local command\n'
    )
  })
  it('reads the SSH review command from .orca/review-command and orca.yaml reviewCommand', async () => {
    store.getRepo.mockReturnValue({
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1'
    })
    const fsProvider = {
      readFile: vi.fn(async (filePath: string) => {
        if (filePath.endsWith('/.orca/review-command')) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        }
        if (filePath.endsWith('/orca.yaml')) {
          return {
            content: 'issueCommand: Complete it\nreviewCommand: Review it\n',
            isBinary: false
          }
        }
        throw new Error(`unexpected read ${filePath}`)
      })
    }
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)
    parseOrcaYamlMock.mockReturnValue({
      scripts: {},
      issueCommand: 'Complete it',
      reviewCommand: 'Review it'
    })

    await expect(
      handlers['hooks:readIssueCommand'](null, { repoId: 'repo-ssh', kind: 'review' })
    ).resolves.toMatchObject({
      status: 'ok',
      localContent: null,
      sharedContent: 'Review it',
      source: 'shared',
      localFilePath: '/remote/repo/.orca/review-command'
    })
    expect(fsProvider.readFile).not.toHaveBeenCalledWith(expect.stringMatching(/issue-command$/))
  })

  it('writes the SSH review override to .orca/review-command', async () => {
    store.getRepo.mockReturnValue({
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1'
    })
    const checkIgnoredPaths = vi.fn().mockResolvedValue(['.orca/review-command'])
    getSshGitProviderMock.mockReturnValue({ checkIgnoredPaths })
    const fsProvider = {
      createDir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn(),
      writeFile: vi.fn().mockResolvedValue(undefined),
      deletePath: vi.fn().mockResolvedValue(undefined)
    }
    getSshFilesystemProviderMock.mockReturnValue(fsProvider)

    await handlers['hooks:writeIssueCommand'](null, {
      repoId: 'repo-ssh',
      content: 'Review it',
      kind: 'review'
    })

    expect(checkIgnoredPaths).toHaveBeenCalledWith('/remote/repo', ['.orca/review-command'])
    expect(fsProvider.writeFile).toHaveBeenCalledExactlyOnceWith(
      '/remote/repo/.orca/review-command',
      'Review it\n'
    )
  })

  it('reads the issue command when no kind is sent', async () => {
    store.getRepo.mockReturnValue({
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1'
    })
    getSshFilesystemProviderMock.mockReturnValue({
      readFile: vi.fn(async (filePath: string) => {
        if (filePath.endsWith('/.orca/issue-command')) {
          return { content: 'local issue\n', isBinary: false }
        }
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      })
    })

    await expect(
      handlers['hooks:readIssueCommand'](null, { repoId: 'repo-ssh' })
    ).resolves.toMatchObject({ localContent: 'local issue' })
  })
})
