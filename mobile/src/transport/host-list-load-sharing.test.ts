import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dropSharedHostListLoad, shareHostListLoad } from './host-list-load-sharing'
import type { HostProfile } from './types'

function deferred() {
  let resolve: (hosts: HostProfile[]) => void = () => {}
  const promise = new Promise<HostProfile[]>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('shareHostListLoad', () => {
  beforeEach(() => {
    dropSharedHostListLoad()
  })

  it('runs one pass for callers that arrive while it is still open', async () => {
    const pass = deferred()
    const load = vi.fn(() => pass.promise)

    const first = shareHostListLoad(load)
    const second = shareHostListLoad(load)
    pass.resolve([])

    expect(load).toHaveBeenCalledTimes(1)
    expect(await first).toBe(await second)
  })

  it('starts a fresh pass for callers that arrive after a write dropped it', async () => {
    const stale = deferred()
    const fresh = deferred()
    const load = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)

    const before = shareHostListLoad(load)
    dropSharedHostListLoad()
    const after = shareHostListLoad(load)

    stale.resolve([])
    fresh.resolve([])
    expect(load).toHaveBeenCalledTimes(2)
    expect(await after).not.toBe(await before)
  })

  it('keeps the replacement pass on offer when the dropped one settles late', async () => {
    const stale = deferred()
    const fresh = deferred()
    const load = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)

    const before = shareHostListLoad(load)
    dropSharedHostListLoad()
    const replacement = shareHostListLoad(load)
    // The dropped pass settles after its replacement was registered.
    stale.resolve([])
    await before

    expect(shareHostListLoad(load)).toBe(replacement)
    expect(load).toHaveBeenCalledTimes(2)
    fresh.resolve([])
    await replacement
  })
})
