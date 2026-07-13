import { describe, expect, it, vi } from 'vitest'
import { mapPtyStopsWithConcurrency, WORKTREE_PTY_STOP_CONCURRENCY } from './pty-stop-concurrency'

describe('mapPtyStopsWithConcurrency', () => {
  it('attempts and awaits every PTY before surfacing the first rejection', async () => {
    const ids = Array.from(
      { length: WORKTREE_PTY_STOP_CONCURRENCY + 3 },
      (_, index) => `pty-${index}`
    )
    const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
    const stopPty = vi.fn(
      (ptyId: string) =>
        new Promise<string>((resolve, reject) => {
          pending.set(ptyId, { resolve: () => resolve(ptyId), reject })
        })
    )

    const stopping = mapPtyStopsWithConcurrency(ids, stopPty)
    let settled = false
    const observed = stopping.then(
      () => {
        settled = true
        return null
      },
      (error: unknown) => {
        settled = true
        return error
      }
    )
    await vi.waitFor(() => expect(stopPty).toHaveBeenCalledTimes(WORKTREE_PTY_STOP_CONCURRENCY))
    pending.get('pty-0')!.reject(new Error('first failed'))
    await vi.waitFor(() => expect(stopPty).toHaveBeenCalledTimes(WORKTREE_PTY_STOP_CONCURRENCY + 1))
    await Promise.resolve()
    expect(settled).toBe(false)

    for (const id of ids.slice(1)) {
      pending.get(id)?.resolve()
      await Promise.resolve()
    }
    await vi.waitFor(() => expect(stopPty).toHaveBeenCalledTimes(ids.length))
    for (const id of ids) {
      pending.get(id)?.resolve()
    }

    await expect(observed).resolves.toEqual(expect.objectContaining({ message: 'first failed' }))
    expect(stopPty.mock.calls.map(([ptyId]) => ptyId)).toEqual(ids)
  })
})
