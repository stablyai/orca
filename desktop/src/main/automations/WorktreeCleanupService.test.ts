// FE-TASK-AUTO-008: WorktreeCleanupService is dead code today (no
// composition root instantiates it — see CR-AUTO-006) but its safety check
// must be verified before it's ever wired in for real. This test does NOT
// start/wire the service against a live composition root; it only exercises
// runCleanup() directly, the way a future caller would.
import { describe, expect, it, vi } from 'vitest'
import { WorktreeCleanupService } from './WorktreeCleanupService'
import type { DevServerRelayBridge } from '../dev-server/dev-server-relay-bridge'

function fakeRelay(
  call: (method: string, params: unknown) => Promise<unknown>
): DevServerRelayBridge {
  return { call } as unknown as DevServerRelayBridge
}

const OLD_TIMESTAMP = Date.now() - 30 * 24 * 3600_000 // 30 days ago

describe('WorktreeCleanupService', () => {
  it('never deletes a worktree with uncommitted changes, even if eligible by age/status', async () => {
    const deleteCalls: unknown[] = []
    const relay = fakeRelay(async (method, params) => {
      if (method === 'git.exec') {
        const args = (params as { args: string[] }).args
        if (args[0] === 'status') {
          return { stdout: ' M src/dirty-file.ts\n' } // uncommitted change present
        }
        if (args[0] === 'worktree') {
          deleteCalls.push(params)
        }
      }
      return null
    })
    const service = new WorktreeCleanupService(relay, { maxAgeMs: 7 * 24 * 3600_000 })
    service.listWorktrees = async () => [
      {
        id: 'wt-1',
        path: '/repo/wt-1',
        repoPath: '/repo',
        status: 'idle',
        createdAt: OLD_TIMESTAMP
      }
    ]

    const result = await service.runCleanup()

    expect(deleteCalls).toHaveLength(0)
    expect(result).toMatchObject({ cleanedCount: 0, skippedCount: 1, errorCount: 0 })
  })

  it('deletes a clean, eligible worktree via git worktree remove --force', async () => {
    const deleteCalls: unknown[] = []
    const relay = fakeRelay(async (method, params) => {
      if (method === 'git.exec') {
        const args = (params as { args: string[] }).args
        if (args[0] === 'status') {
          return { stdout: '' } // clean
        }
        if (args[0] === 'worktree') {
          deleteCalls.push(params)
        }
      }
      return null
    })
    const service = new WorktreeCleanupService(relay, { maxAgeMs: 7 * 24 * 3600_000 })
    service.listWorktrees = async () => [
      {
        id: 'wt-1',
        path: '/repo/wt-1',
        repoPath: '/repo',
        status: 'idle',
        createdAt: OLD_TIMESTAMP
      }
    ]

    const result = await service.runCleanup()

    expect(deleteCalls).toEqual([
      { cwd: '/repo', args: ['worktree', 'remove', '--force', '/repo/wt-1'] }
    ])
    expect(result).toMatchObject({ cleanedCount: 1, skippedCount: 0, errorCount: 0 })
  })

  it('skips worktrees that are too young or not in an eligible status', async () => {
    const relay = fakeRelay(async () => null)
    const service = new WorktreeCleanupService(relay, { maxAgeMs: 7 * 24 * 3600_000 })
    service.listWorktrees = async () => [
      {
        id: 'wt-young',
        path: '/repo/young',
        repoPath: '/repo',
        status: 'idle',
        createdAt: Date.now()
      },
      {
        id: 'wt-active',
        path: '/repo/active',
        repoPath: '/repo',
        status: 'running',
        createdAt: OLD_TIMESTAMP
      }
    ]

    const result = await service.runCleanup()

    expect(result).toMatchObject({ cleanedCount: 0, skippedCount: 0, errorCount: 0 })
  })

  it('dry run reports what would be deleted without calling git worktree remove', async () => {
    const deleteCalls: unknown[] = []
    const relay = fakeRelay(async (method, params) => {
      if (method === 'git.exec') {
        const args = (params as { args: string[] }).args
        if (args[0] === 'status') {
          return { stdout: '' }
        }
        if (args[0] === 'worktree') {
          deleteCalls.push(params)
        }
      }
      return null
    })
    const service = new WorktreeCleanupService(relay, { maxAgeMs: 7 * 24 * 3600_000, dryRun: true })
    service.listWorktrees = async () => [
      {
        id: 'wt-1',
        path: '/repo/wt-1',
        repoPath: '/repo',
        status: 'idle',
        createdAt: OLD_TIMESTAMP
      }
    ]

    const result = await service.runCleanup()

    expect(deleteCalls).toHaveLength(0)
    expect(result).toMatchObject({ cleanedCount: 1, skippedCount: 0, errorCount: 0 })
  })

  it('treats a failed git status check as unsafe (conservative skip), not a delete', async () => {
    const deleteCalls: unknown[] = []
    const relay = fakeRelay(async (method, params) => {
      if (method === 'git.exec') {
        const args = (params as { args: string[] }).args
        if (args[0] === 'status') {
          throw new Error('relay disconnected')
        }
        if (args[0] === 'worktree') {
          deleteCalls.push(params)
        }
      }
      return null
    })
    const service = new WorktreeCleanupService(relay, { maxAgeMs: 7 * 24 * 3600_000 })
    service.listWorktrees = async () => [
      {
        id: 'wt-1',
        path: '/repo/wt-1',
        repoPath: '/repo',
        status: 'idle',
        createdAt: OLD_TIMESTAMP
      }
    ]

    const result = await service.runCleanup()

    expect(deleteCalls).toHaveLength(0)
    expect(result).toMatchObject({ cleanedCount: 0, skippedCount: 1, errorCount: 0 })
  })

  it('one worktree erroring does not stop the rest of the cycle', async () => {
    const relay = fakeRelay(async (method, params) => {
      if (method === 'git.exec') {
        const args = (params as { args: string[] }).args
        const cwd = (params as { cwd: string }).cwd
        if (args[0] === 'status') {
          return { stdout: '' }
        }
        if (args[0] === 'worktree' && cwd === '/repo-a') {
          throw new Error('remove failed: locked')
        }
      }
      return null
    })
    const service = new WorktreeCleanupService(relay, { maxAgeMs: 7 * 24 * 3600_000 })
    service.listWorktrees = async () => [
      {
        id: 'wt-a',
        path: '/repo-a/wt',
        repoPath: '/repo-a',
        status: 'idle',
        createdAt: OLD_TIMESTAMP
      },
      {
        id: 'wt-b',
        path: '/repo-b/wt',
        repoPath: '/repo-b',
        status: 'idle',
        createdAt: OLD_TIMESTAMP
      }
    ]

    const result = await service.runCleanup()

    expect(result).toMatchObject({ cleanedCount: 1, skippedCount: 0, errorCount: 1 })
  })

  it('fires onCleanupComplete with the cycle result', async () => {
    const relay = fakeRelay(async () => null)
    const service = new WorktreeCleanupService(relay, { maxAgeMs: 7 * 24 * 3600_000 })
    service.listWorktrees = async () => []
    const onCleanupComplete = vi.fn()
    service.onCleanupComplete = onCleanupComplete

    await service.runCleanup()

    expect(onCleanupComplete).toHaveBeenCalledWith(
      expect.objectContaining({ cleanedCount: 0, skippedCount: 0, errorCount: 0 })
    )
  })
})
