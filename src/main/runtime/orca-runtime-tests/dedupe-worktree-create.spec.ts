import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { store } from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService.dedupeWorktreeCreate', () => {
  it('coalesces concurrent creates that share a clientMutationId', async () => {
    const runtime = new OrcaRuntimeService(store)
    let calls = 0
    const factory = (): Promise<{ worktree: { id: string } }> => {
      calls += 1
      return Promise.resolve({ worktree: { id: 'wt' } })
    }
    const [a, b] = await Promise.all([
      runtime.dedupeWorktreeCreate('id:r', 'key-1', factory),
      runtime.dedupeWorktreeCreate('id:r', 'key-1', factory)
    ])
    expect(calls).toBe(1)
    expect(a).toBe(b)
  })

  it('reuses a settled success for a retry whose response was lost in a cutover', async () => {
    const runtime = new OrcaRuntimeService(store)
    let calls = 0
    const factory = (): Promise<{ worktree: { id: string } }> => {
      calls += 1
      return Promise.resolve({ worktree: { id: `wt-${calls}` } })
    }
    const first = await runtime.dedupeWorktreeCreate('id:r', 'key-1', factory)
    const retried = await runtime.dedupeWorktreeCreate('id:r', 'key-1', factory)
    expect(calls).toBe(1)
    expect(retried).toEqual(first)
  })

  it('expires settled successes after the reconnect window', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      let calls = 0
      const factory = (): Promise<{ n: number }> => Promise.resolve({ n: (calls += 1) })
      await runtime.dedupeWorktreeCreate('id:r', 'key-1', factory)
      await vi.advanceTimersByTimeAsync(59_999)
      await runtime.dedupeWorktreeCreate('id:r', 'key-1', factory)
      expect(calls).toBe(1)

      await vi.advanceTimersByTimeAsync(1)
      await runtime.dedupeWorktreeCreate('id:r', 'key-1', factory)
      expect(calls).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a failed create so a genuine retry starts fresh', async () => {
    const runtime = new OrcaRuntimeService(store)
    let calls = 0
    const factory = (): Promise<never> => {
      calls += 1
      return Promise.reject(new Error(`boom-${calls}`))
    }
    await expect(runtime.dedupeWorktreeCreate('id:r', 'key-1', factory)).rejects.toThrow('boom-1')
    await expect(runtime.dedupeWorktreeCreate('id:r', 'key-1', factory)).rejects.toThrow('boom-2')
    expect(calls).toBe(2)
  })

  it('never dedupes across repos or when no clientMutationId is supplied', async () => {
    const runtime = new OrcaRuntimeService(store)
    let calls = 0
    const factory = (): Promise<{ n: number }> => {
      calls += 1
      return Promise.resolve({ n: calls })
    }
    await runtime.dedupeWorktreeCreate('id:a', 'key-1', factory)
    await runtime.dedupeWorktreeCreate('id:b', 'key-1', factory)
    await runtime.dedupeWorktreeCreate('id:a', undefined, factory)
    await runtime.dedupeWorktreeCreate('id:a', undefined, factory)
    expect(calls).toBe(4)
  })
})
