import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPtyProvider, PtyProcessInfo } from '../../../../providers/pty-provider-contract'
import { createAdapter } from './daemon-pty-router-test-fixture'
import { DaemonSessionOwnerResolver } from '../daemon-session-owner-resolution'
import { sweepProviderByPrefix } from '../../../../runtime/workspaces/removal/worktree-pty-surface-sweeps'

const row = (id = 'shared', incarnationId = 'live'): PtyProcessInfo => ({
  id,
  incarnationId,
  cwd: '/project',
  title: 'shell'
})

function adapter(listProcesses: IPtyProvider['listProcesses']) {
  const provider = createAdapter('inventory')
  vi.mocked(provider.listProcesses).mockImplementation(listProcesses)
  return provider
}

function delayedInventory(
  delayMs: number,
  processes: () => PtyProcessInfo[]
): IPtyProvider['listProcesses'] {
  return (opts) => {
    const deadlineMs = opts?.deadlineMs
    if (deadlineMs === undefined) {
      throw new Error('Inventory fixture requires the actual RPC deadline')
    }
    return new Promise((resolve, reject) => {
      const success = setTimeout(() => {
        clearTimeout(timeout)
        resolve(processes())
      }, delayMs)
      const timeout = setTimeout(
        () => {
          clearTimeout(success)
          reject(new Error('Inventory RPC deadline exceeded'))
        },
        Math.max(0, deadlineMs - Date.now())
      )
    })
  }
}

describe('daemon inventory acquisition budget', () => {
  afterEach(() => vi.useRealTimers())

  it('refreshes cleanup after a timed-out restore and stops an externally created PTY', async () => {
    vi.useFakeTimers()
    const worktreeId = 'repo::/project'
    const targetId = `${worktreeId}@@external`
    let rows: PtyProcessInfo[] = []
    const fast = adapter(async () => [...rows])
    const slow = adapter(
      vi
        .fn<IPtyProvider['listProcesses']>()
        .mockImplementationOnce(delayedInventory(3_000, () => []))
        .mockResolvedValue([])
    )
    const resolver = new DaemonSessionOwnerResolver([fast, slow], new Map())
    const restore = resolver.resolve('missing-restore-pane')
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(restore).resolves.toEqual({ kind: 'unknown' })
    rows = [row(targetId)]
    const facade = adapter((opts) => resolver.listProcesses(opts))
    vi.mocked(facade.shutdown).mockImplementation(async (id) => {
      rows = rows.filter((process) => process.id !== id)
    })

    const sweep = sweepProviderByPrefix(
      worktreeId,
      facade,
      Date.now() + 10_000,
      async (_id, stop) => {
        const stopped = await stop()
        return { stopped, owner: stopped }
      },
      undefined,
      true
    )
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(sweep).resolves.toBe(1)
    expect(facade.shutdown).toHaveBeenCalledExactlyOnceWith(targetId, expect.anything())
    expect(rows).toEqual([])
    expect(fast.listProcesses).toHaveBeenCalledTimes(2)
    expect(slow.listProcesses).toHaveBeenCalledTimes(2)
  })
})
