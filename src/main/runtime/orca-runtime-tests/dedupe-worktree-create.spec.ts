import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { store } from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService.dedupeWorktreeCreate', () => {
  const reservation = {
    key: 'key-1',
    reservationId: 'reservation-1',
    sessionId: 'session-1',
    resourceKind: 'worktree' as const,
    ownershipGeneration: 1,
    issuer: 'openloop'
  }

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

  it('rejects a conflicting binding while the reservation result is cached', async () => {
    const runtime = new OrcaRuntimeService(store)
    const factory = vi.fn(async () => ({ worktree: { id: 'wt' } }))
    await runtime.dedupeWorktreeCreate('id:r', reservation.key, factory, reservation)

    await expect(
      runtime.dedupeWorktreeCreate('id:r', reservation.key, factory, {
        ...reservation,
        reservationId: 'reservation-2'
      })
    ).rejects.toMatchObject({ code: 'reservation_conflict' })
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('keeps reservation keys separate from transport mutation ids', async () => {
    const runtime = new OrcaRuntimeService(store)
    const factory = vi.fn(async () => ({ worktree: { id: `wt-${factory.mock.calls.length}` } }))
    await runtime.dedupeWorktreeCreate('id:r', reservation.key, factory)
    await runtime.dedupeWorktreeCreate('id:r', reservation.key, factory, reservation)
    expect(factory).toHaveBeenCalledTimes(2)
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
