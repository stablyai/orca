import { describe, expect, it, vi } from 'vitest'
import type { DescendantSnapshot } from './pty-descendant-termination'
import { terminateDescendantSnapshotWithVerdict } from './pty-descendant-exit-verification'
import { forceKillFinishedWorktreeSessionTree } from './worktree-finished-session-tree-kill'

const snapshot: DescendantSnapshot = {
  root: { pid: 4242, startedAt: 'Mon Jan 1 00:00:00 2020' },
  rootPgid: 4242,
  descendants: [{ pid: 4243, ppid: 4242, pgid: 4242, startedAt: 'Mon Jan 1 00:00:01 2020' }],
  capturedAtMs: Date.now()
}

describe('forceKillFinishedWorktreeSessionTree', () => {
  it('signals SIGTERM through the descendant sweep, then asks the verdict API to SIGKILL survivors', async () => {
    const signals: string[] = []
    let terminated: DescendantSnapshot | undefined
    const killWithDescendantSweep = vi.fn(async (_pid: number, killRoot: () => void) => {
      killRoot()
    })
    const terminate = vi.fn(async (tree: DescendantSnapshot) => {
      terminated = tree
      return 'live' as const
    })

    const result = await forceKillFinishedWorktreeSessionTree([4242], {
      platform: 'linux',
      captureDescendantSnapshot: async () => snapshot,
      killWithDescendantSweep,
      terminateDescendantSnapshotWithVerdict: terminate,
      sendSignal: (_pid, signal) => {
        signals.push(signal)
      }
    })

    expect(signals).toEqual(['SIGTERM'])
    expect(killWithDescendantSweep).toHaveBeenCalledOnce()
    expect(terminate).toHaveBeenCalledOnce()
    expect(terminated?.descendants.map((row) => row.pid)).toEqual([4242, 4243])
    expect(result.livePids).toEqual([4242])
  })

  it('escalates SIGTERM to SIGKILL for a root that is still the same process', async () => {
    const signals: string[] = []
    const row = {
      pid: 4242,
      ppid: 1,
      pgid: 4242,
      startedAt: 'Mon Jan 1 00:00:00 2020'
    }
    const verdict = await terminateDescendantSnapshotWithVerdict(
      {
        root: { pid: 4242, startedAt: row.startedAt },
        rootPgid: 4242,
        descendants: [row],
        capturedAtMs: Date.now()
      },
      {
        graceMs: 15,
        verifyMs: 60,
        timeoutMs: 50,
        sendSignal: (_pid, signal) => {
          signals.push(signal)
        },
        readTable: async () => ({
          rows: [row],
          capturedAtMs: Date.now()
        })
      }
    )

    expect(verdict).toBe('live')
    expect(signals[0]).toBe('SIGTERM')
    expect(signals).toContain('SIGKILL')
  })
})
