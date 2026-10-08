import { describe, expect, it, vi, type Mock } from 'vitest'
import { OffscreenPaintLease, type OffscreenPaintLeaseWebContents } from './offscreen-paint-lease'

function makeWebContents(id: number): OffscreenPaintLeaseWebContents & {
  setBackgroundThrottling: Mock<OffscreenPaintLeaseWebContents['setBackgroundThrottling']>
  invalidate: Mock<NonNullable<OffscreenPaintLeaseWebContents['invalidate']>>
} {
  return {
    id,
    isDestroyed: vi.fn(() => false),
    setBackgroundThrottling: vi.fn<OffscreenPaintLeaseWebContents['setBackgroundThrottling']>(),
    invalidate: vi.fn<NonNullable<OffscreenPaintLeaseWebContents['invalidate']>>()
  }
}

describe('OffscreenPaintLease', () => {
  it('disables throttling and invalidates on first acquire only', () => {
    const lease = new OffscreenPaintLease()
    const wc = makeWebContents(1)

    const releaseA = lease.acquire(wc)
    const releaseB = lease.acquire(wc)

    expect(wc.setBackgroundThrottling).toHaveBeenCalledTimes(1)
    expect(wc.setBackgroundThrottling).toHaveBeenCalledWith(false)
    expect(wc.invalidate).toHaveBeenCalledTimes(1)

    releaseA()
    expect(wc.setBackgroundThrottling).toHaveBeenCalledTimes(1)

    releaseB()
    expect(wc.setBackgroundThrottling).toHaveBeenCalledTimes(2)
    expect(wc.setBackgroundThrottling).toHaveBeenLastCalledWith(true)
  })

  it('release is idempotent', () => {
    const lease = new OffscreenPaintLease()
    const wc = makeWebContents(1)
    const release = lease.acquire(wc)

    release()
    release()

    expect(wc.setBackgroundThrottling.mock.calls).toEqual([[false], [true]])
  })

  it('re-enables throttling again on a fresh acquire cycle', () => {
    const lease = new OffscreenPaintLease()
    const wc = makeWebContents(1)

    lease.acquire(wc)()
    lease.acquire(wc)()

    expect(wc.setBackgroundThrottling.mock.calls).toEqual([[false], [true], [false], [true]])
  })

  it('tolerates a destroyed webContents on acquire and release', () => {
    const lease = new OffscreenPaintLease()
    const wc = makeWebContents(1)
    wc.isDestroyed = vi.fn(() => true)

    const release = lease.acquire(wc)
    expect(() => release()).not.toThrow()
    expect(wc.setBackgroundThrottling).not.toHaveBeenCalled()
  })

  it('tracks refcounts per webContents independently', () => {
    const lease = new OffscreenPaintLease()
    const a = makeWebContents(1)
    const b = makeWebContents(2)

    const releaseA = lease.acquire(a)
    const releaseB = lease.acquire(b)
    releaseB()

    expect(a.setBackgroundThrottling).toHaveBeenCalledWith(false)
    expect(b.setBackgroundThrottling.mock.calls).toEqual([[false], [true]])
    expect(a.setBackgroundThrottling).not.toHaveBeenCalledWith(true)
    releaseA()
    expect(a.setBackgroundThrottling).toHaveBeenLastCalledWith(true)
  })
})
