import { describe, expect, it, vi } from 'vitest'
import { browserCaptureIdle } from './browser-capture-idle'
import { createDesktopBrowserViewServiceFixture } from './desktop-browser-view-service-test-fixture'
import { deferred } from './desktop-owned-browser-view-test-fixture'

describe('DesktopBrowserViewService', () => {
  it('attaches policies, registers ownership and reports readiness before navigating a hidden view', async () => {
    const f = createDesktopBrowserViewServiceFixture()
    const state = await f.service.create(f.sender, f.args)
    expect(f.order).toEqual(['policy', 'register', 'ready', 'load'])
    expect(f.native.view.getVisible()).toBe(false)
    expect(f.owner.contentView.children).toContain(f.container)
    expect(f.container.children).toContain(f.native.view)
    expect(f.manager.getGuestWebContentsId(f.args.browserPageId)).toBe(f.guest.id)
    expect(state).toMatchObject({
      browserPageId: f.args.browserPageId,
      url: f.args.url,
      loading: true
    })
    expect(state.generation).not.toBe(f.native.record.generation)
    expect(state.revision).toBeGreaterThan(0)
    await f.service.close(f.sender, state)
  })

  it('refuses unknown profiles and occupied page identities before attaching or navigating', async () => {
    const f = createDesktopBrowserViewServiceFixture()
    await expect(
      f.service.create(f.sender, { ...f.args, sessionProfileId: 'missing' })
    ).rejects.toThrow('known session')
    expect(f.guest.loadURL).not.toHaveBeenCalled()
    f.registered.set(f.args.browserPageId, 99)
    await expect(f.service.create(f.sender, f.args)).rejects.toThrow('already exists')
    expect(f.owner.contentView.children).not.toContain(f.native.view)
    expect(f.registered.get(f.args.browserPageId)).toBe(99)
  })

  it('awaits actual destruction after registration refusal and does not withdraw a foreign mapping', async () => {
    const f = createDesktopBrowserViewServiceFixture({ autoDestroy: false })
    f.manager.registerOwnedView.mockImplementation(() => {
      f.registered.set(f.args.browserPageId, 99)
      return false
    })
    const create = f.service.create(f.sender, f.args)
    const rejected = expect(create).rejects.toThrow('registration was refused')
    let settled = false
    void create.catch(() => {
      settled = true
    })
    await vi.waitFor(() => expect(f.guest.closeCalls).toBe(1))
    expect(settled).toBe(false)
    expect(f.guest.loadURL).not.toHaveBeenCalled()
    f.guest.finishClose()
    await rejected
    expect(f.manager.unregisterGuest).not.toHaveBeenCalled()
    expect(f.registered.get(f.args.browserPageId)).toBe(99)
  })

  it('fences commands and clips the native container without shrinking the page viewport', async () => {
    const f = createDesktopBrowserViewServiceFixture()
    const state = await f.service.create(f.sender, f.args)
    const foreign = Object.create(f.sender)
    foreign.id = 9
    await expect(
      f.service.command(foreign, { ...state, command: { kind: 'snapshot' } })
    ).rejects.toThrow('identity')
    await expect(
      f.service.command(f.sender, { ...state, generation: 'stale', command: { kind: 'back' } })
    ).rejects.toThrow('identity')
    await f.service.updateLayout(f.sender, {
      ...state,
      bounds: { x: 20, y: 100, width: 600, height: 500 },
      visible: true,
      inputLocked: false
    })
    expect(f.container.getBounds()).toEqual({ x: 40, y: 200, width: 860, height: 450 })
    expect(f.native.view.getBounds()).toEqual({ x: 0, y: 0, width: 1200, height: 1000 })
    expect(f.native.view.getVisible()).toBe(true)
    await f.service.updateLayout(f.sender, {
      ...state,
      bounds: { x: 20, y: 100, width: 600, height: 500 },
      visible: true,
      inputLocked: true
    })
    const focus = await f.service.command(f.sender, { ...state, command: { kind: 'focus' } })
    expect(f.native.view.getVisible()).toBe(false)
    expect(focus.state.focused).toBe(false)
    expect(f.guest.focus).not.toHaveBeenCalled()
    await f.service.close(f.sender, state)
    expect(f.owner.contentView.children).not.toContain(f.container)
  })

  it('serializes zoom behind actual capture settlement', async () => {
    const f = createDesktopBrowserViewServiceFixture()
    const state = await f.service.create(f.sender, f.args)
    const pixels = deferred<void>()
    browserCaptureIdle.trackNative(f.native.view.webContents, pixels.promise)
    const zoom = f.service.command(f.sender, { ...state, command: { kind: 'zoom', level: 2 } })
    await Promise.resolve()
    expect(f.guest.setZoomLevel).not.toHaveBeenCalled()
    pixels.resolve()
    expect((await zoom).state.zoomLevel).toBe(2)
    await f.service.close(f.sender, state)
  })

  it('stops navigation and fences viewport capture by the current renderer and generation', async () => {
    const f = createDesktopBrowserViewServiceFixture()
    const state = await f.service.create(f.sender, f.args)
    await f.service.command(f.sender, { ...state, command: { kind: 'stop' } })
    expect(f.guest.stop).toHaveBeenCalledOnce()
    const image = await f.service.captureViewport(f.sender, state)
    expect(image).toEqual({ dataUrl: 'data:image/png;base64,cGl4ZWxz', width: 800, height: 600 })
    expect(f.captureViewport).toHaveBeenCalledWith(
      expect.objectContaining({
        browserPageId: state.browserPageId,
        generation: state.generation,
        webContents: f.native.view.webContents
      })
    )
    await expect(
      f.service.captureViewport(f.sender, { ...state, generation: 'stale' })
    ).rejects.toThrow('identity')
    const foreign = Object.create(f.sender)
    foreign.id = 99
    await expect(f.service.captureViewport(foreign, state)).rejects.toThrow('identity')
    expect(f.captureViewport).toHaveBeenCalledOnce()
    await f.service.close(f.sender, state)
    await expect(f.service.captureViewport(f.sender, state)).rejects.toThrow('identity')
  })

  it('drains capture and owner cleanup before native close, retaining identity until destruction', async () => {
    const f = createDesktopBrowserViewServiceFixture({ autoDestroy: false })
    const state = await f.service.create(f.sender, f.args)
    const pixels = deferred<void>()
    const retirement = deferred<void>()
    browserCaptureIdle.trackNative(f.native.view.webContents, pixels.promise)
    f.retirePage.mockImplementation(() => retirement.promise)
    const close = f.service.close(f.sender, state)
    expect(f.service.close(f.sender, state)).toBe(close)
    await Promise.resolve()
    expect(f.retirePage).not.toHaveBeenCalled()
    await expect(
      f.service.command(f.sender, { ...state, command: { kind: 'back' } })
    ).rejects.toThrow('identity')
    pixels.resolve()
    await vi.waitFor(() => expect(f.retirePage).toHaveBeenCalledOnce())
    expect(f.guest.closeCalls).toBe(0)
    retirement.resolve()
    await vi.waitFor(() => expect(f.guest.closeCalls).toBe(1))
    expect(f.manager.getGuestWebContentsId(f.args.browserPageId)).toBe(f.guest.id)
    f.guest.finishClose()
    await close
    expect(f.manager.getGuestWebContentsId(f.args.browserPageId)).toBeNull()
    expect(f.events.some((event) => event.kind === 'destroyed')).toBe(true)
  })

  it('closes old views when the owning renderer reloads', async () => {
    const f = createDesktopBrowserViewServiceFixture()
    await f.service.create(f.sender, f.args)
    f.senderShape.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    await vi.waitFor(() => expect(f.guest.destroyed).toBe(true))
    expect(f.manager.getGuestWebContentsId(f.args.browserPageId)).toBeNull()
    expect(f.senderShape.listenerCount('did-start-navigation')).toBe(0)
  })

  it('retains failed owner cleanup for an explicit same-generation retry', async () => {
    const f = createDesktopBrowserViewServiceFixture()
    const state = await f.service.create(f.sender, f.args)
    f.retirePage.mockRejectedValueOnce(new Error('owner cleanup failed'))
    await expect(f.service.close(f.sender, state)).rejects.toThrow('owner cleanup failed')
    expect(f.guest.destroyed).toBe(false)
    expect(f.manager.getGuestWebContentsId(f.args.browserPageId)).toBe(f.guest.id)
    await f.service.close(f.sender, state)
    expect(f.guest.destroyed).toBe(true)
    expect(f.manager.getGuestWebContentsId(f.args.browserPageId)).toBeNull()
  })
})
