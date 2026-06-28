import { describe, expect, it, vi } from 'vitest'
import { WorktreeSnapshotSource, type WorktreeSnapshotState } from './worktree-snapshot-source'
import type { TuiRpcClient } from './tui-rpc-client'
import { makePsResult, makeWorktreeSummary } from './worktree-snapshot-fixtures'

function asClient(call: ReturnType<typeof vi.fn>): TuiRpcClient {
  return { call } as unknown as TuiRpcClient
}

function okClient(worktreeId = 'wt-1'): { client: TuiRpcClient; call: ReturnType<typeof vi.fn> } {
  const call = vi.fn(async (method: string) => {
    if (method !== 'worktree.ps') {
      throw new Error(`unexpected method ${method}`)
    }
    return { result: makePsResult([makeWorktreeSummary({ worktreeId })]) }
  })
  return { client: asClient(call), call }
}

describe('WorktreeSnapshotSource', () => {
  it('fetches the whole worktree in exactly one RPC per tick', async () => {
    const { client, call } = okClient()
    const source = new WorktreeSnapshotSource(client)
    await source.refreshOnce()
    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0][0]).toBe('worktree.ps')
  })

  it('exposes a connected snapshot after a successful fetch', async () => {
    const { client } = okClient('wt-42')
    const source = new WorktreeSnapshotSource(client, { now: () => 123 })
    await source.refreshOnce()
    const state = source.getState()
    expect(state.connected).toBe(true)
    expect(state.error).toBeNull()
    expect(state.lastUpdatedAt).toBe(123)
    expect(state.snapshot?.groups[0].worktrees[0].worktreeId).toBe('wt-42')
  })

  it('notifies subscribers with the latest state', async () => {
    const { client } = okClient()
    const source = new WorktreeSnapshotSource(client)
    const listener = vi.fn<(state: WorktreeSnapshotState) => void>()
    source.subscribe(listener)
    await source.refreshOnce()
    // subscribers are notified, and the notified state is the connected one
    expect(listener).toHaveBeenCalled()
    expect(source.getState().connected).toBe(true)
  })

  it('marks disconnected on failure while keeping the last snapshot', async () => {
    let mode: 'ok' | 'fail' = 'ok'
    const call = vi.fn(async () => {
      if (mode === 'fail') {
        throw new Error('runtime down')
      }
      return { result: makePsResult([makeWorktreeSummary()]) }
    })
    const source = new WorktreeSnapshotSource(asClient(call))
    await source.refreshOnce()
    mode = 'fail'
    await source.refreshOnce()
    const state = source.getState()
    expect(state.connected).toBe(false)
    expect(state.error).toContain('runtime down')
    // last good snapshot is retained so the UI doesn't blank out
    expect(state.snapshot).not.toBeNull()
  })

  it('recovers (clears the error) on the next successful fetch', async () => {
    let mode: 'ok' | 'fail' = 'fail'
    const call = vi.fn(async () => {
      if (mode === 'fail') {
        throw new Error('down')
      }
      return { result: makePsResult([makeWorktreeSummary()]) }
    })
    const source = new WorktreeSnapshotSource(asClient(call))
    await source.refreshOnce()
    expect(source.getState().connected).toBe(false)
    mode = 'ok'
    await source.refreshOnce()
    expect(source.getState().connected).toBe(true)
    expect(source.getState().error).toBeNull()
  })

  it('drives the poll loop through the injected timer and stops cleanly', async () => {
    const { client, call } = okClient()
    const pending: (() => void)[] = []
    const source = new WorktreeSnapshotSource(client, {
      intervalMs: 50,
      setTimer: (cb) => {
        pending.push(cb)
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {}
    })
    source.start()
    await Promise.resolve()
    await Promise.resolve()
    expect(call).toHaveBeenCalledTimes(1)
    expect(pending).toHaveLength(1)
    source.stop()
    // firing a stale timer after stop must not schedule more work
    pending[0]()
    await Promise.resolve()
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('backs off exponentially on consecutive failures and resets on recovery', async () => {
    let mode: 'fail' | 'ok' = 'fail'
    const call = vi.fn(async () => {
      if (mode === 'fail') {
        throw new Error('down')
      }
      return { result: makePsResult([]) }
    })
    const delays: number[] = []
    const pending: (() => void)[] = []
    const source = new WorktreeSnapshotSource(asClient(call), {
      intervalMs: 100,
      setTimer: (cb, ms) => {
        delays.push(ms)
        pending.push(cb)
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {}
    })
    const flush = async () => {
      await Promise.resolve()
      await Promise.resolve()
    }

    source.start()
    await flush() // tick 1 fails -> backoff for 1 failure
    pending.pop()?.()
    await flush() // tick 2 fails -> backoff for 2 failures
    mode = 'ok'
    pending.pop()?.()
    await flush() // tick 3 succeeds -> delay resets to intervalMs

    expect(delays[0]).toBe(200) // 100 * 2^1
    expect(delays[1]).toBe(400) // 100 * 2^2
    expect(delays[2]).toBe(100) // reset to intervalMs after recovery
  })
})
