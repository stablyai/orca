import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repository/repo-types'

const { statfs } = vi.hoisted(() => ({ statfs: vi.fn() }))
vi.mock('node:fs/promises', () => ({ statfs }))
vi.mock('electron', () => ({ webContents: { fromId: () => undefined } }))
vi.mock('../browser/guest-lifecycle/manager/browser-manager', () => ({ browserManager: {} }))

const GB = 1024 ** 3
const repo: Repo = {
  id: 'r1',
  path: '/vol/dev/app',
  displayName: 'app',
  badgeColor: '#000',
  addedAt: 1,
  kind: 'git'
}

function store(workspaceDir: string, worktreePaths: string[] = []) {
  return {
    getSettings: () => ({ workspaceDir, nestWorkspaces: true }),
    getRepos: () => [repo],
    getAllWorktreeMetaForHost: () =>
      Object.fromEntries(worktreePaths.map((path) => [`${repo.id}::${path}`, {}]))
  }
}

describe('readPerfNoticeSignals', () => {
  beforeEach(() => {
    vi.resetModules()
    statfs.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.runIf(process.platform !== 'win32')(
    'reads the volume under the repo for a relative workspace folder',
    async () => {
      statfs.mockResolvedValue({ bavail: 2, bsize: GB, blocks: 500 })
      const { readPerfNoticeSignals } = await import('./perf-notice-signals')

      const signals = await readPerfNoticeSignals(store('.orca/worktrees'))

      expect(statfs.mock.calls.map(([path]) => path)).toEqual(['/vol/dev/app/.orca/worktrees'])
      expect(signals.disk).toEqual({ freeBytes: 2 * GB, totalBytes: 500 * GB })
    }
  )

  it.runIf(process.platform !== 'win32')(
    'warns about the volume holding existing workspaces after the workspace folder moved',
    async () => {
      statfs.mockImplementation(async (path: string) =>
        path === '/vol/old/workspaces/app'
          ? { bavail: 1, bsize: GB, blocks: 500 }
          : { bavail: 400, bsize: GB, blocks: 500 }
      )
      const { readPerfNoticeSignals } = await import('./perf-notice-signals')

      const signals = await readPerfNoticeSignals(
        store('/vol/new/workspaces', [
          '/vol/dev/app',
          '/vol/new/workspaces/app/signup',
          '/vol/old/workspaces/app/login-form',
          '/vol/old/workspaces/app/billing'
        ])
      )

      // The repo's own checkout is not a workspace, and each folder is read once.
      expect(statfs.mock.calls.map(([path]) => path)).toEqual([
        '/vol/new/workspaces',
        '/vol/old/workspaces/app'
      ])
      expect(signals.disk).toEqual({ freeBytes: 1 * GB, totalBytes: 500 * GB })
    }
  )

  it.runIf(process.platform !== 'win32')(
    'warns about another disk while one folder stays hung',
    async () => {
      vi.useFakeTimers()
      statfs.mockImplementation((path: string) =>
        path === '/vol/hung'
          ? new Promise(() => {})
          : Promise.resolve({ bavail: 1, bsize: GB, blocks: 500 })
      )
      const { readPerfNoticeSignals } = await import('./perf-notice-signals')

      const first = readPerfNoticeSignals(store('/vol/hung', ['/vol/full/workspaces/a']))
      await vi.advanceTimersByTimeAsync(15_000)
      expect(await first).toEqual({ disk: { freeBytes: 1 * GB, totalBytes: 500 * GB } })

      expect(await readPerfNoticeSignals(store('/vol/new'))).toEqual({
        disk: { freeBytes: 1 * GB, totalBytes: 500 * GB }
      })
    }
  )
})
