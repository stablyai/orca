import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { Store } from '../persistence'

const { getSshPtyProviderMock } = vi.hoisted(() => ({
  getSshPtyProviderMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn()
  }
}))

vi.mock('./pty', () => ({
  getSshPtyProvider: getSshPtyProviderMock
}))

vi.mock('../memory/pty-registry', () => ({
  listRegisteredPtys: vi.fn(() => [])
}))

vi.mock('../workspace-cleanup-scan-snapshot', () => ({
  persistWorkspaceCleanupScanResult: vi.fn(async () => undefined),
  readWorkspaceCleanupScanSnapshot: vi.fn(async () => null)
}))

vi.mock('../workspace-cleanup-removal-snapshot-prune', () => ({
  beginWorkspaceCleanupRemovalSnapshotPruneBatch: vi.fn(),
  finishWorkspaceCleanupRemovalSnapshotPruneBatch: vi.fn(async () => undefined),
  recordWorkspaceCleanupRemovalSnapshotPrune: vi.fn()
}))

import { registerWorkspaceCleanupHandlers } from './workspace-cleanup'

function makeEmptyStore(): Store {
  return {
    getProfileStorageDirectory: () => '/profile-a',
    getRepos: () => [],
    getWorktreeMeta: () => ({}),
    getAllWorktreeMeta: () => ({}),
    getGitHubCache: () => ({ pr: {}, issue: {} })
  } as unknown as Store
}

function getPreflightHandler(): ((...args: never[]) => unknown) | undefined {
  return vi
    .mocked(ipcMain.handle)
    .mock.calls.find(([channel]) => channel === 'workspaceCleanup:hasKillableLocalProcesses')?.[1]
}

describe('workspace cleanup process preflight', () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockReset()
    getSshPtyProviderMock.mockReset()
  })

  it('reports local processes that workspace deletion would kill', async () => {
    const localProvider = {
      listProcesses: vi.fn().mockResolvedValue([
        {
          id: 'repo-1::/repo-feature@@session-1',
          cwd: '/repo-feature',
          title: 'zsh'
        }
      ])
    }
    registerWorkspaceCleanupHandlers(makeEmptyStore(), {
      runtime: {
        hasTerminalsForWorktree: vi.fn().mockResolvedValue(false)
      } as never,
      getLocalPtyProvider: () => localProvider as never
    })

    await expect(
      getPreflightHandler()?.({} as never, { worktreeId: 'repo-1::/repo-feature' } as never)
    ).resolves.toEqual({
      hasKillableProcesses: true
    })
  })

  it('reports SSH processes inside the remote workspace path', async () => {
    getSshPtyProviderMock.mockReturnValue({
      listProcesses: vi.fn().mockResolvedValue([
        {
          id: 'remote-session-1',
          cwd: '/remote/repo-feature/subdir',
          title: 'codex'
        }
      ])
    })
    registerWorkspaceCleanupHandlers(makeEmptyStore(), {
      runtime: {
        hasTerminalsForWorktree: vi.fn().mockResolvedValue(false)
      } as never
    })

    await expect(
      getPreflightHandler()?.(
        {} as never,
        {
          worktreeId: 'repo-ssh::/remote/repo-feature',
          connectionId: 'ssh-1',
          worktreePath: '/remote/repo-feature'
        } as never
      )
    ).resolves.toEqual({
      hasKillableProcesses: true
    })
  })
})
