import { describe, expect, it, vi } from 'vitest'
import {
  LINEAR_PROJECT_MAX_INFLIGHT_KEYS,
  LINEAR_PROJECT_MAX_INFLIGHT_KEY_BYTES,
  LinearProjectRequestCoalescer
} from './linear-project-request-coalescer'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('LinearProjectRequestCoalescer', () => {
  it('preserves ordinary same-key coalescing and cleans up after settlement', async () => {
    const coalescer = new LinearProjectRequestCoalescer()
    const request = deferred<string>()
    const load = vi.fn(() => request.promise)

    const first = coalescer.coalesce('projects:alpha', load)
    const second = coalescer.coalesce('projects:alpha', load)
    expect(first).toBe(second)
    expect(load).toHaveBeenCalledTimes(1)
    expect(coalescer.trackedRequestCount).toBe(1)

    request.resolve('done')
    await expect(first).resolves.toBe('done')
    expect(coalescer.trackedRequestCount).toBe(0)
  })

  it('tracks the exact key-count boundary and executes key +1 untracked', async () => {
    const coalescer = new LinearProjectRequestCoalescer()
    const requests = Array.from({ length: LINEAR_PROJECT_MAX_INFLIGHT_KEYS + 1 }, () =>
      deferred<number>()
    )
    const promises = requests.map((request, index) =>
      coalescer.coalesce(`key-${index}`, () => request.promise)
    )

    expect(coalescer.trackedRequestCount).toBe(LINEAR_PROJECT_MAX_INFLIGHT_KEYS)
    requests.forEach((request, index) => request.resolve(index))
    await expect(Promise.all(promises)).resolves.toHaveLength(requests.length)
    expect(coalescer.trackedRequestCount).toBe(0)
  })

  it('tracks an exact-size key and executes key byte +1 untracked', async () => {
    const coalescer = new LinearProjectRequestCoalescer()
    const exactRequest = deferred<string>()
    const exact = coalescer.coalesce(
      'a'.repeat(LINEAR_PROJECT_MAX_INFLIGHT_KEY_BYTES),
      () => exactRequest.promise
    )
    const over = coalescer.coalesce(
      'a'.repeat(LINEAR_PROJECT_MAX_INFLIGHT_KEY_BYTES + 1),
      async () => 'over'
    )

    expect(coalescer.trackedRequestCount).toBe(1)
    await expect(over).resolves.toBe('over')
    expect(coalescer.trackedRequestCount).toBe(1)
    exactRequest.resolve('exact')
    await expect(exact).resolves.toBe('exact')
    expect(coalescer.trackedRequestCount).toBe(0)
  })

  it('keeps a forced replacement tracked when the older request settles', async () => {
    const coalescer = new LinearProjectRequestCoalescer()
    const staleRequest = deferred<string>()
    const freshRequest = deferred<string>()

    const stale = coalescer.coalesce('same', () => staleRequest.promise)
    const fresh = coalescer.coalesce('same', () => freshRequest.promise, true)
    staleRequest.resolve('stale')
    await expect(stale).resolves.toBe('stale')
    expect(coalescer.trackedRequestCount).toBe(1)

    freshRequest.resolve('fresh')
    await expect(fresh).resolves.toBe('fresh')
    expect(coalescer.trackedRequestCount).toBe(0)
  })
})
