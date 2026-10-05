import { describe, expect, it, vi } from 'vitest'
import { browserCaptureIdle } from './browser-capture-idle'
import { DesktopOwnedBrowserView } from './desktop-owned-browser-view'
import { createOwnedViewFixture, deferred } from './desktop-owned-browser-view-test-fixture'

describe('DesktopOwnedBrowserView', () => {
  it('runs afterIdle only after raw native work from the completed callback settles', async () => {
    const fixture = createOwnedViewFixture()
    const native = deferred<void>()
    const afterIdle = vi.fn(async () => {})
    const capture = fixture.controller.withStableView(() => {
      browserCaptureIdle.trackNative(fixture.record.webContents, native.promise)
      return 'caller-returned'
    }, afterIdle)
    await Promise.resolve()
    expect(afterIdle).not.toHaveBeenCalled()
    native.resolve()
    await expect(capture).resolves.toBe('caller-returned')
    expect(afterIdle).toHaveBeenCalledOnce()
    await fixture.controller.close()
  })

  it('runs afterIdle under the same reservation and waits for its raw work before release', async () => {
    const fixture = createOwnedViewFixture()
    const afterNative = deferred<void>()
    const completed = fixture.controller.withStableView(
      () => 'pixels',
      async () => {
        expect(() =>
          browserCaptureIdle.assertCaptureAllowed(fixture.record.webContents)
        ).not.toThrow()
        browserCaptureIdle.trackNative(fixture.record.webContents, afterNative.promise)
      }
    )
    await vi.waitFor(() =>
      expect(() => browserCaptureIdle.assertCaptureAllowed(fixture.record.webContents)).toThrow(
        'reserved'
      )
    )
    afterNative.resolve()
    await expect(completed).resolves.toBe('pixels')
    expect(() => browserCaptureIdle.assertCaptureAllowed(fixture.record.webContents)).not.toThrow()
    await fixture.controller.close()
  })

  it('releases a callback failure only after actual raw capture settlement', async () => {
    const fixture = createOwnedViewFixture()
    const native = deferred<void>()
    const failed = fixture.controller.withStableView(() => {
      browserCaptureIdle.trackPrimary(fixture.record.webContents, native.promise)
      throw new Error('capture callback failed')
    })
    await Promise.resolve()
    expect(() => browserCaptureIdle.assertCaptureAllowed(fixture.record.webContents)).toThrow(
      'reserved'
    )
    native.resolve()
    await expect(failed).rejects.toThrow('capture callback failed')
    expect(() => browserCaptureIdle.assertCaptureAllowed(fixture.record.webContents)).not.toThrow()
    await fixture.controller.close()
  })

  it('fences reuse after an afterIdle rejection even when its reason is undefined', async () => {
    const fixture = createOwnedViewFixture()
    await expect(
      fixture.controller.withStableView(
        () => 'pixels',
        async () => {
          await Promise.resolve()
          throw undefined
        }
      )
    ).rejects.toBeUndefined()
    expect(() => browserCaptureIdle.assertCaptureAllowed(fixture.record.webContents)).toThrow(
      'reserved'
    )
    expect(() =>
      fixture.controller.updateLayout({ x: 0, y: 0, width: 100, height: 100 }, true)
    ).toThrow('fenced')
    await fixture.controller.close()
  })
  it('serializes capture, layout, capture, then close', async () => {
    const fixture = createOwnedViewFixture()
    const entered = deferred<void>()
    const release = deferred<void>()
    const first = fixture.controller.withStableView(async () => {
      entered.resolve()
      await release.promise
      return 'first'
    })
    await entered.promise
    const layout = fixture.controller.updateLayout({ x: 5, y: 6, width: 120, height: 80 }, false)
    const second = fixture.controller.withStableView(() => 'second')
    const close = fixture.controller.close()
    expect(() =>
      fixture.controller.updateLayout({ x: 0, y: 0, width: 1, height: 1 }, true)
    ).toThrow('closed')
    release.resolve()
    await expect(first).resolves.toBe('first')
    await layout
    await expect(second).resolves.toBe('second')
    await close
    expect(fixture.boundsHistory).toEqual([{ x: 5, y: 6, width: 120, height: 80 }])
    expect(fixture.guest.closeCalls).toBe(1)
  })

  it('does not resize while an external capture remains active', async () => {
    const fixture = createOwnedViewFixture()
    const externalPending = deferred<void>()
    const external = browserCaptureIdle.runCapture(
      fixture.record.webContents,
      () => externalPending.promise
    )
    const layout = fixture.controller.updateLayout({ x: 1, y: 2, width: 300, height: 200 }, false)
    await Promise.resolve()
    expect(fixture.view.getBounds().width).toBe(1152)
    externalPending.resolve()
    await external
    await layout
    expect(fixture.view.getBounds()).toEqual({ x: 1, y: 2, width: 300, height: 200 })
    await fixture.controller.close()
  })

  it('retains a failed retirement lease and lets the same owner retry close', async () => {
    const fixture = createOwnedViewFixture()
    await expect(
      fixture.controller.close(async () => {
        throw new Error('cleanup failed')
      })
    ).rejects.toThrow('cleanup failed')
    expect(fixture.guest.closeCalls).toBe(0)
    expect(() => browserCaptureIdle.assertCaptureAllowed(fixture.record.webContents)).toThrow(
      'reserved'
    )
    await fixture.controller.close()
    expect(fixture.guest.destroyed).toBe(true)
    expect(() => browserCaptureIdle.assertCaptureAllowed(fixture.record.webContents)).not.toThrow()
  })

  it('returns one close promise and waits for the destroyed event', async () => {
    const fixture = createOwnedViewFixture({ autoDestroy: false })
    const first = fixture.controller.close()
    expect(fixture.controller.close()).toBe(first)
    await vi.waitFor(() => expect(fixture.guest.closeCalls).toBe(1))
    let settled = false
    void first.then(() => {
      settled = true
    })
    expect(settled).toBe(false)
    fixture.guest.finishClose()
    await first
    expect(settled).toBe(true)
  })

  it('rejects forged records, wrong owners, stale generations, and lost membership', async () => {
    const fixture = createOwnedViewFixture()
    expect(() => new DesktopOwnedBrowserView({ ...fixture.record }, fixture.host)).toThrow(
      'owned attachment'
    )
    expect(fixture.controller.validate('other', 8, fixture.record.generation)).toBe(false)
    expect(fixture.controller.validate('page', 99, fixture.record.generation)).toBe(false)
    expect(fixture.controller.validate('page', 8, 'stale')).toBe(false)
    fixture.host.contentView.removeChildView(fixture.view)
    expect(fixture.controller.validate('page', 8, fixture.record.generation)).toBe(false)
    await fixture.controller.close()
  })
})
