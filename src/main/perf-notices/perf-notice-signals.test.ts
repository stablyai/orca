import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repository/repo-types'

const { statfs, opendir } = vi.hoisted(() => ({ statfs: vi.fn(), opendir: vi.fn() }))
vi.mock('node:fs/promises', () => ({ statfs, opendir }))

function folderWith(entries: number) {
  let left = entries
  return { read: async () => (left-- > 0 ? {} : null), close: async () => {} }
}

const GB = 1024 ** 3

function store(
  workspaceDir: string,
  workspaceDirHistory: { path: string; nestWorkspaces: boolean }[] = []
) {
  const repo: Repo = {
    id: 'r1',
    path: '/vol/dev/app',
    displayName: 'app',
    badgeColor: '#000',
    addedAt: 1,
    kind: 'git'
  }
  return {
    getSettings: () => ({ workspaceDir, nestWorkspaces: true, workspaceDirHistory }),
    getRepos: () => [repo]
  }
}

describe('readPerfNoticeSignals', () => {
  beforeEach(() => {
    vi.resetModules()
    statfs.mockReset()
    opendir.mockReset()
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
    'warns about an earlier workspace folder only while it still holds workspaces',
    async () => {
      statfs.mockImplementation(async (path: string) =>
        path === '/vol/old/workspaces'
          ? { bavail: 1, bsize: GB, blocks: 500 }
          : { bavail: 400, bsize: GB, blocks: 500 }
      )
      const earlier = [{ path: '/vol/old/workspaces', nestWorkspaces: true }]

      opendir.mockResolvedValue(folderWith(1))
      const withWorkspaces = await import('./perf-notice-signals')
      expect(
        (await withWorkspaces.readPerfNoticeSignals(store('/vol/new/workspaces', earlier))).disk
      ).toEqual({ freeBytes: 1 * GB, totalBytes: 500 * GB })

      vi.resetModules()
      opendir.mockResolvedValue(folderWith(0))
      const emptied = await import('./perf-notice-signals')
      expect(
        (await emptied.readPerfNoticeSignals(store('/vol/new/workspaces', earlier))).disk
      ).toEqual({ freeBytes: 400 * GB, totalBytes: 500 * GB })
    }
  )
})
