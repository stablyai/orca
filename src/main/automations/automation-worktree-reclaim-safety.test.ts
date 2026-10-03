import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHostGitRoute } from '../providers/execution-host-provider-dispatch'
import { inspectAutomationWorktreeGitSafety } from './automation-worktree-reclaim-safety'

const HEAD = 'abc1234def5678'
const BASE = HEAD

function localRoute(): ExecutionHostGitRoute {
  return { kind: 'local', hostId: 'local' }
}

describe('automation worktree reclaim safety', () => {
  it('reclaims only when status is empty and HEAD is the base commit', async () => {
    const execLocal = vi.fn(async (argv: string[]) => {
      if (argv[0] === 'status') {
        return { stdout: '' }
      }
      return { stdout: `${HEAD}\n` }
    })
    await expect(
      inspectAutomationWorktreeGitSafety({
        hostId: 'local',
        cwd: '/wt',
        baseRef: 'origin/main',
        isMainWorktree: false,
        resolveRoute: localRoute,
        execLocal
      })
    ).resolves.toBe('reclaimable')
    expect(execLocal).toHaveBeenCalledWith(['status', '--porcelain', '-z'], '/wt', undefined)
    expect(execLocal).toHaveBeenCalledWith(
      ['rev-parse', '--verify', 'origin/main^{commit}'],
      '/wt',
      undefined
    )
  })

  it('keeps a dirty tree and a tree whose commit is not the base', async () => {
    await expect(
      inspectAutomationWorktreeGitSafety({
        hostId: 'local',
        cwd: '/wt',
        baseRef: 'main',
        isMainWorktree: false,
        resolveRoute: localRoute,
        execLocal: async (argv) => ({ stdout: argv[0] === 'status' ? '?? notes.md\0' : BASE })
      })
    ).resolves.toBe('keep')
    await expect(
      inspectAutomationWorktreeGitSafety({
        hostId: 'local',
        cwd: '/wt',
        baseRef: 'main',
        isMainWorktree: false,
        resolveRoute: localRoute,
        execLocal: async (argv) => ({
          stdout: argv.includes('HEAD') ? 'bbbbbbb\n' : argv[0] === 'status' ? '' : `${BASE}\n`
        })
      })
    ).resolves.toBe('keep')
  })

  it('does not treat a missing SSH provider or a git error as a clean tree', async () => {
    const unreachable: ExecutionHostGitRoute = {
      kind: 'ssh',
      hostId: 'ssh:box',
      connectionId: 'box',
      provider: null
    }
    await expect(
      inspectAutomationWorktreeGitSafety({
        hostId: 'ssh:box',
        cwd: '/remote/wt',
        baseRef: 'main',
        isMainWorktree: false,
        resolveRoute: () => unreachable
      })
    ).resolves.toBe('unverifiable')
    await expect(
      inspectAutomationWorktreeGitSafety({
        hostId: 'local',
        cwd: '/wt',
        baseRef: 'main',
        isMainWorktree: false,
        resolveRoute: localRoute,
        execLocal: async () => {
          throw new Error('connection reset')
        }
      })
    ).resolves.toBe('unverifiable')
    await expect(
      inspectAutomationWorktreeGitSafety({
        hostId: 'local',
        cwd: '/repo',
        baseRef: 'main',
        isMainWorktree: true,
        resolveRoute: localRoute,
        execLocal: async () => ({ stdout: '' })
      })
    ).resolves.toBe('keep')
  })
})
