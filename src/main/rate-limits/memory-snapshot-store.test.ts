import { describe, expect, it } from 'vitest'
import { MemorySnapshotStore } from './memory-snapshot-store'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('MemorySnapshotStore', () => {
  it('coalesces refreshes and reports snapshot age', async () => {
    let now = 100
    const store = new MemorySnapshotStore<string>(() => now)
    const load = deferred<{ value: string; availability: 'ready' }>()
    const loader = () => load.promise

    const first = store.refresh(loader)
    const second = store.refresh(loader)
    load.resolve({ value: 'token', availability: 'ready' })

    await Promise.all([first, second])
    now = 140
    expect(store.get()).toEqual({
      value: 'token',
      stale: false,
      age: 40,
      availability: 'ready'
    })
  })

  it('retains last-known-good data as stale after a denied refresh', async () => {
    const store = new MemorySnapshotStore<string>()
    store.publishOwned({ value: 'token', availability: 'ready' })
    await store.refresh(
      async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' })
      },
      () => 'denied'
    )

    expect(store.get()).toMatchObject({ value: 'token', stale: true, availability: 'denied' })
    expect(store.getFreshValue()).toBeNull()
  })

  it('rejects a late refresh publication after revocation', async () => {
    const store = new MemorySnapshotStore<string>()
    const load = deferred<{ value: string; availability: 'ready' }>()
    const refresh = store.refresh(() => load.promise)

    store.revoke()
    load.resolve({ value: 'revoked', availability: 'ready' })
    await refresh

    expect(store.get()).toMatchObject({ value: null, stale: false, availability: 'missing' })
  })

  it('queues one current refresh without overlapping an invalidated loader', async () => {
    const store = new MemorySnapshotStore<string>()
    const oldLoad = deferred<{ value: string; availability: 'ready' }>()
    const nextLoad = deferred<{ value: string; availability: 'ready' }>()
    const nextStarted = deferred<void>()
    let activeLoads = 0
    let maximumActiveLoads = 0
    let nextLoadCalls = 0
    const track = async <T>(load: Promise<T>): Promise<T> => {
      activeLoads += 1
      maximumActiveLoads = Math.max(maximumActiveLoads, activeLoads)
      try {
        return await load
      } finally {
        activeLoads -= 1
      }
    }
    const oldRefresh = store.refresh(() => track(oldLoad.promise))

    store.invalidate()
    const nextLoader = () => {
      nextLoadCalls += 1
      nextStarted.resolve()
      return track(nextLoad.promise)
    }
    const nextRefresh = store.refresh(nextLoader)
    const coalescedRefresh = store.refresh(nextLoader)

    await Promise.resolve()
    expect(nextLoadCalls).toBe(0)
    expect(activeLoads).toBe(1)
    oldLoad.resolve({ value: 'obsolete', availability: 'ready' })
    await oldRefresh
    await nextStarted.promise
    expect(nextLoadCalls).toBe(1)
    expect(maximumActiveLoads).toBe(1)
    nextLoad.resolve({ value: 'current', availability: 'ready' })
    await Promise.all([nextRefresh, coalescedRefresh])

    expect(store.get()).toMatchObject({ value: 'current', stale: false, availability: 'ready' })
  })

  it('retries after a bounded loader failure releases the flight', async () => {
    const store = new MemorySnapshotStore<string>()
    const deadline = deferred<never>()
    let starts = 0
    const loader = async () => {
      starts += 1
      if (starts === 1) {
        return await deadline.promise
      }
      return { value: 'recovered', availability: 'ready' as const }
    }
    const first = store.refresh(loader)

    store.invalidate()
    const recovery = store.refresh(loader)
    deadline.reject(Object.assign(new Error('deadline'), { code: 'ETIMEDOUT' }))
    await first
    await recovery

    expect(starts).toBe(2)
    expect(store.get()).toMatchObject({ value: 'recovered', stale: false, availability: 'ready' })
  })
})
