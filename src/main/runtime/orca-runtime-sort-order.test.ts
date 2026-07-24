import { describe, expect, it, vi } from 'vitest'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import { OrcaRuntimeService } from './orca-runtime'

function makeRuntime() {
  const metadata = new Map<string, { sortOrder: number }>()
  const setWorktreeMeta = vi.fn((worktreeId: string, meta: { sortOrder: number }) => {
    metadata.set(worktreeId, meta)
  })
  const store = {
    getWorktreeMeta: vi.fn((worktreeId: string) => metadata.get(worktreeId)),
    setWorktreeMeta
  }
  const runtime = new OrcaRuntimeService(store as never)
  const invalidateResolvedWorktreeCache = vi.spyOn(
    runtime as unknown as { invalidateResolvedWorktreeCache: () => void },
    'invalidateResolvedWorktreeCache'
  )
  const events: RuntimeClientEvent[] = []
  runtime.onClientEvent((event) => events.push(event))

  return { events, invalidateResolvedWorktreeCache, runtime, setWorktreeMeta }
}

describe('OrcaRuntimeService sort-order persistence', () => {
  it('emits remote refreshes only when the requested order changes', () => {
    const { events, invalidateResolvedWorktreeCache, runtime, setWorktreeMeta } = makeRuntime()
    // Why: sort-order snapshots only rewrite existing meta (#9342); seed entries first.
    // Seed inverted ranks so the first request actually needs a write.
    setWorktreeMeta('first', { sortOrder: 0 })
    setWorktreeMeta('second', { sortOrder: 1 })
    setWorktreeMeta.mockClear()

    expect(runtime.persistManagedWorktreeSortOrder(['first', 'second'])).toEqual({ updated: 2 })
    expect(setWorktreeMeta).toHaveBeenCalledTimes(2)
    expect(invalidateResolvedWorktreeCache).toHaveBeenCalledTimes(1)
    expect(events).toEqual([{ type: 'reposChanged' }])

    expect(runtime.persistManagedWorktreeSortOrder(['first', 'second'])).toEqual({ updated: 0 })
    expect(setWorktreeMeta).toHaveBeenCalledTimes(2)
    expect(invalidateResolvedWorktreeCache).toHaveBeenCalledTimes(1)
    expect(events).toEqual([{ type: 'reposChanged' }])

    expect(runtime.persistManagedWorktreeSortOrder(['second', 'first'])).toEqual({ updated: 2 })
    expect(setWorktreeMeta).toHaveBeenCalledTimes(4)
    expect(invalidateResolvedWorktreeCache).toHaveBeenCalledTimes(2)
    expect(events).toEqual([{ type: 'reposChanged' }, { type: 'reposChanged' }])
  })

  it('does not write, invalidate, or emit for empty input', () => {
    const { events, invalidateResolvedWorktreeCache, runtime, setWorktreeMeta } = makeRuntime()

    expect(runtime.persistManagedWorktreeSortOrder([])).toEqual({ updated: 0 })
    expect(setWorktreeMeta).not.toHaveBeenCalled()
    expect(invalidateResolvedWorktreeCache).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })
})
