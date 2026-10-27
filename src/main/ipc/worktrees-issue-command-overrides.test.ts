import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as issueCommandFile from '../issue-command-file'
import * as projectGitOptions from '../project-runtime-git-options'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addWorktreeMock, listWorktreesMock } from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'

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
vi.mock('./worktree-symlinks', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeSymlinksModuleMock()
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
vi.mock('./pty/provider/registry', async () =>
  (await import('./worktrees-test-module-mocks')).ptyRegistryModuleMock()
)
vi.mock('./pty/provider/state-cleanup', async () =>
  (await import('./worktrees-test-module-mocks')).ptyStateCleanupModuleMock()
)

const REMOTE_REPO_PATH = '/remote/repo'

function makeRepo(fields: Record<string, unknown>) {
  return {
    id: 'repo-1',
    path: REMOTE_REPO_PATH,
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    worktreeBaseRef: 'origin/main',
    ...fields
  }
}

function useRepo(repo: ReturnType<typeof makeRepo>): void {
  store.getRepos.mockReturnValue([repo])
  store.getRepo.mockReturnValue(repo)
  store.setWorktreeMeta.mockImplementation((_target: unknown, meta: unknown) => meta)
}

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
        expect.any(Function)
      )
    } finally {
      resolveOptions.mockRestore()
      write.mockRestore()
    }
  })

  it('rejects SSH issue-command writes, which this process does not serve', async () => {
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

    await expect(
      handlers['hooks:writeIssueCommand'](null, {
        repoId: 'repo-ssh',
        content: 'orca issue command'
      })
    ).rejects.toThrow('Remote filesystem unavailable')
  })
})

describe('worktrees:create execution host routing', () => {
  beforeEach(() => {
    setupWorktreeHandlers()
  })

  it('refuses a row that names an SSH host only as executionHostId instead of creating locally', async () => {
    useRepo(makeRepo({ executionHostId: 'ssh:target-a' }))

    await expect(
      handlers['worktrees:create'](null, { repoId: 'repo-1', name: 'wt' })
    ).rejects.toThrow(SshHostNotServedError)

    expect(addWorktreeMock).not.toHaveBeenCalled()
  })

  it('refuses a runtime row with no nested SSH target instead of creating locally', async () => {
    useRepo(makeRepo({ executionHostId: 'runtime:env-1' }))

    await expect(
      handlers['worktrees:create'](null, { repoId: 'repo-1', name: 'wt' })
    ).rejects.toThrow('not dispatched by this process')

    expect(addWorktreeMock).not.toHaveBeenCalled()
  })

  it('refuses a runtime row that also names a nested SSH target', async () => {
    // This target belongs to env-1, never the local client.
    useRepo(makeRepo({ executionHostId: 'runtime:env-1', connectionId: 'target-a' }))

    await expect(
      handlers['worktrees:create'](null, { repoId: 'repo-1', name: 'wt' })
    ).rejects.toThrow('not dispatched by this process')

    expect(addWorktreeMock).not.toHaveBeenCalled()
  })

  it('answers local for a row that declares itself local while carrying a connection', async () => {
    // Explicit local ownership overrides legacy connection fields.
    useRepo(
      makeRepo({ path: '/workspace/repo', executionHostId: 'local', connectionId: 'target-a' })
    )
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/wt',
        head: 'abc123',
        branch: 'wt',
        isBare: false,
        isMainWorktree: false
      }
    ])
    await handlers['worktrees:create'](null, { repoId: 'repo-1', name: 'wt' })

    expect(addWorktreeMock).toHaveBeenCalledTimes(1)
  })
})
