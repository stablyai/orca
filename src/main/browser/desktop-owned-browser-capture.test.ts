import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureFullPageScreenshot, captureScreenshot } from './cdp-screenshot'
import { browserCaptureIdle } from './browser-capture-idle'
import { DesktopOwnedBrowserCapture } from './desktop-owned-browser-capture'
import {
  getDesktopOwnedBrowserCapture,
  registerDesktopOwnedBrowserCapture
} from './desktop-owned-browser-capture-registry'
import { createOwnedBrowserCaptureFixture } from './desktop-owned-browser-capture-test-fixture'
import { deferred } from './desktop-owned-browser-view-test-fixture'

const noHold = (): (() => void) => () => {}

describe('desktop-owned browser direct capture routing', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('captures full-page and explicit proxy clips on the unchanged owned surface', async () => {
    const f = createOwnedBrowserCaptureFixture()
    const coordinator = new DesktopOwnedBrowserCapture()
    const dispose = coordinator.register(f.controller, f.owner)
    const originalBounds = { ...f.state.bounds }
    await expect(captureFullPageScreenshot(f.record.webContents, 'jpeg', noHold)).resolves.toEqual({
      data: 'owned-page-pixels',
      format: 'jpeg'
    })
    expect(f.captures[0]).toEqual({
      bounds: originalBounds,
      params: {
        format: 'jpeg',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: 1152, height: 2728, scale: 1 }
      }
    })
    const clip = { x: 0.5, y: 1.5, width: 700.5, height: 1600.5, scale: 0.75 }
    await expect(
      captureScreenshot(
        f.record.webContents,
        { format: 'png', captureBeyondViewport: true, clip },
        noHold
      )
    ).resolves.toEqual({ data: 'owned-page-pixels' })
    expect(f.captures[1]).toEqual({
      bounds: originalBounds,
      params: { format: 'png', captureBeyondViewport: true, clip }
    })
    expect(f.state.bounds).toEqual(originalBounds)
    expect(f.state.visible).toBe(false)
    expect(f.host.contentView.children).toContain(f.view)
    expect(browserCaptureIdle.isIdle(f.record.webContents)).toBe(true)
    await dispose()
    await f.controller.close()
  })

  it('restores the original scroll without changing native parent, bounds, or visibility', async () => {
    const f = createOwnedBrowserCaptureFixture()
    const coordinator = new DesktopOwnedBrowserCapture()
    const dispose = coordinator.register(f.controller, f.owner)
    const originalBounds = { ...f.state.bounds }
    f.properties.scrollY = 81
    await captureFullPageScreenshot(f.record.webContents, 'png', noHold)
    expect(f.properties.scrollWrites.at(-1)).toEqual({ x: 0, y: 81 })
    expect(f.properties.scrollY).toBe(81)
    expect(f.state.bounds).toEqual(originalBounds)
    expect(f.state.visible).toBe(false)
    expect(f.host.contentView.children).toContain(f.view)
    await dispose()
    await f.controller.close()
  })

  it('waits for a late native pulse before restoring, laying out, or closing the view', async () => {
    vi.useFakeTimers()
    const f = createOwnedBrowserCaptureFixture()
    const coordinator = new DesktopOwnedBrowserCapture()
    const dispose = coordinator.register(f.controller, f.owner)
    const primary = deferred<{ data: string }>()
    const pulse = deferred<Electron.NativeImage>()
    const send = f.sendCommand.getMockImplementation()!
    f.sendCommand.mockImplementation((method, params) =>
      method === 'Page.captureScreenshot' ? primary.promise : send(method, params)
    )
    f.guest.capturePage.mockReturnValue(pulse.promise)
    const capture = captureFullPageScreenshot(f.record.webContents, 'png', noHold)
    await vi.advanceTimersByTimeAsync(250)
    primary.resolve({ data: 'complete-pixels' })
    await vi.advanceTimersByTimeAsync(0)
    const layout = f.controller.updateLayout({ x: 1, y: 2, width: 600, height: 400 }, false)
    const close = f.controller.close()
    expect(f.state.bounds).toEqual({ x: 4, y: 40, width: 1152, height: 642 })
    expect(f.guest.closeCalls).toBe(0)
    pulse.reject(new Error('pulse complete'))
    await expect(capture).resolves.toEqual({ data: 'complete-pixels', format: 'png' })
    await layout
    await close
    expect(f.state.bounds).toEqual({ x: 1, y: 2, width: 600, height: 400 })
    expect(f.guest.closeCalls).toBe(1)
    await dispose()
  })

  it('holds close behind a metrics command that outlives its caller timeout', async () => {
    vi.useFakeTimers()
    const f = createOwnedBrowserCaptureFixture()
    const coordinator = new DesktopOwnedBrowserCapture()
    const dispose = coordinator.register(f.controller, f.owner)
    const metrics = deferred<unknown>()
    const send = f.sendCommand.getMockImplementation()!
    let firstMetrics = true
    f.sendCommand.mockImplementation((method, params) => {
      if (method === 'Runtime.evaluate' && firstMetrics) {
        firstMetrics = false
        return metrics.promise
      }
      return send(method, params)
    })
    const capture = captureFullPageScreenshot(f.record.webContents, 'png', noHold)
    await vi.advanceTimersByTimeAsync(8000)
    expect(browserCaptureIdle.isIdle(f.record.webContents)).toBe(false)
    const close = f.controller.close()
    expect(f.guest.closeCalls).toBe(0)
    metrics.resolve({
      result: {
        value: {
          innerWidth: 1152,
          innerHeight: 642,
          devicePixelRatio: 1,
          scrollX: 0,
          scrollY: 81
        }
      }
    })
    await expect(capture).rejects.toThrow('Timed out while running Runtime.evaluate.')
    await close
    expect(f.guest.closeCalls).toBe(1)
    await dispose()
  })
  it('rejects navigation and does not apply the old document scroll to a new document', async () => {
    const f = createOwnedBrowserCaptureFixture()
    const coordinator = new DesktopOwnedBrowserCapture()
    const dispose = coordinator.register(f.controller, f.owner)
    const primary = deferred<{ data: string }>()
    const send = f.sendCommand.getMockImplementation()!
    f.sendCommand.mockImplementation((method, params) =>
      method === 'Page.captureScreenshot' ? primary.promise : send(method, params)
    )
    const capture = captureFullPageScreenshot(f.record.webContents, 'png', noHold)
    await vi.waitFor(() =>
      expect(f.sendCommand.mock.calls.some(([method]) => method === 'Page.captureScreenshot')).toBe(
        true
      )
    )
    f.properties.scrollY = 24
    f.properties.timeOrigin = 54321
    f.guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    primary.resolve({ data: 'new-document-pixels' })
    await expect(capture).rejects.toThrow('navigated during capture')
    expect(f.properties.scrollWrites).toEqual([])
    expect(f.properties.scrollY).toBe(24)
    await dispose()
    await f.controller.close()
  })

  it('rejects forged registration, disposes stale registration, and leaves direct calls unregistered', async () => {
    const f = createOwnedBrowserCaptureFixture()
    expect(() =>
      registerDesktopOwnedBrowserCapture({ ...f.record }, async () => ({ data: '' }))
    ).toThrow('identity')
    const coordinator = new DesktopOwnedBrowserCapture()
    const dispose = coordinator.register(f.controller, f.owner)
    await dispose()
    await expect(captureFullPageScreenshot(f.record.webContents, 'png', noHold)).resolves.toEqual({
      data: 'owned-page-pixels',
      format: 'png'
    })
    await f.controller.close()
  })

  it('allows separate pages to capture concurrently without a shared host', async () => {
    const a = createOwnedBrowserCaptureFixture()
    const b = createOwnedBrowserCaptureFixture()
    const coordinator = new DesktopOwnedBrowserCapture()
    const disposeA = coordinator.register(a.controller, a.owner)
    const disposeB = coordinator.register(b.controller, b.owner)
    const first = deferred<{ data: string }>()
    const send = a.sendCommand.getMockImplementation()!
    a.sendCommand.mockImplementation((method, params) =>
      method === 'Page.captureScreenshot' ? first.promise : send(method, params)
    )
    const captureA = captureFullPageScreenshot(a.record.webContents, 'png', noHold)
    const captureB = captureFullPageScreenshot(b.record.webContents, 'png', noHold)
    await vi.waitFor(() => expect(b.captures).toHaveLength(1))
    first.resolve({ data: 'a-pixels' })
    await expect(captureA).resolves.toEqual({ data: 'a-pixels', format: 'png' })
    await expect(captureB).resolves.toEqual({ data: 'owned-page-pixels', format: 'png' })
    expect(a.host.contentView.children).toContain(a.view)
    expect(b.host.contentView.children).toContain(b.view)
    await disposeA()
    await disposeB()
    await a.controller.close()
    await b.controller.close()
  })
})

it('settles the owned viewport paint pulse before CDP capture or later layout', async () => {
  const f = createOwnedBrowserCaptureFixture()
  const coordinator = new DesktopOwnedBrowserCapture()
  const dispose = coordinator.register(f.controller, f.owner)
  const pulse = deferred<void>()
  f.guest.capturePage.mockReturnValue(pulse.promise)
  const route = getDesktopOwnedBrowserCapture(f.record.webContents)
  if (!route) {
    throw new Error('Owned capture route was not registered')
  }
  const capture = route(
    { kind: 'screenshot', params: { format: 'png', captureBeyondViewport: false } },
    noHold
  )
  for (let i = 0; i < 12; i++) {
    await Promise.resolve()
  }
  expect(f.guest.capturePage).toHaveBeenCalledWith(undefined, {
    stayHidden: false,
    stayAwake: false
  })
  expect(f.captures).toHaveLength(0)
  const originalBounds = { ...f.state.bounds }
  const layout = f.controller.updateLayout({ x: 1, y: 2, width: 600, height: 400 }, false)
  await Promise.resolve()
  expect(f.state.bounds).toEqual(originalBounds)
  pulse.resolve()
  await expect(capture).resolves.toEqual({ data: 'owned-page-pixels' })
  expect(f.captures[0].bounds).toEqual(originalBounds)
  await layout
  expect(f.state.visible).toBe(false)
  expect(browserCaptureIdle.isIdle(f.record.webContents)).toBe(true)
  dispose()
  await f.controller.close()
})

it('rejects a one-pixel CSS viewport on a full-size owned view without publishing CDP pixels', async () => {
  const f = createOwnedBrowserCaptureFixture()
  const coordinator = new DesktopOwnedBrowserCapture()
  const dispose = coordinator.register(f.controller, f.owner)
  const send = f.sendCommand.getMockImplementation()!
  f.sendCommand.mockImplementation((method, params) => {
    if (method === 'Runtime.evaluate' && !String(params?.expression).includes('window.scrollTo')) {
      return Promise.resolve({
        result: {
          value: {
            innerWidth: 1,
            innerHeight: 1,
            devicePixelRatio: 1,
            timeOrigin: f.properties.timeOrigin,
            scrollX: f.properties.scrollX,
            scrollY: f.properties.scrollY
          }
        }
      })
    }
    return send(method, params)
  })
  const route = getDesktopOwnedBrowserCapture(f.record.webContents)
  if (!route) {
    throw new Error('Owned capture route missing')
  }
  await expect(
    route({ kind: 'screenshot', params: { format: 'png', captureBeyondViewport: false } }, noHold)
  ).rejects.toThrow('css=1x1, owned=1152x642')
  expect(f.captures).toHaveLength(0)
  expect(f.state.visible).toBe(false)
  expect(browserCaptureIdle.isIdle(f.record.webContents)).toBe(true)
  dispose()
  await f.controller.close()
})

it('synchronizes a hidden frame from native geometry and restores CSS, zoom, scroll and visibility', async () => {
  const f = createOwnedBrowserCaptureFixture()
  f.properties.viewportWidth = 1
  f.properties.viewportHeight = 1
  f.properties.zoomFactor = 2
  const coordinator = new DesktopOwnedBrowserCapture()
  const dispose = coordinator.register(f.controller, f.owner)
  const route = getDesktopOwnedBrowserCapture(f.record.webContents)
  if (!route) {
    throw new Error('Owned capture route missing')
  }
  await expect(
    route({ kind: 'screenshot', params: { format: 'png', captureBeyondViewport: false } }, noHold)
  ).resolves.toEqual({ data: 'owned-page-pixels' })
  const sizes = f.sendCommand.mock.calls.filter(([method]) => method === 'Emulation.setVisibleSize')
  expect(sizes).toEqual([
    ['Emulation.setVisibleSize', { width: 1152, height: 642 }],
    ['Emulation.setVisibleSize', { width: 2, height: 2 }]
  ])
  expect(
    f.sendCommand.mock.calls.some(([method]) => method === 'Emulation.setDeviceMetricsOverride')
  ).toBe(false)
  expect(f.properties.viewportWidth).toBe(1)
  expect(f.properties.viewportHeight).toBe(1)
  expect(f.properties.zoomFactor).toBe(2)
  expect(f.properties.scrollY).toBe(81)
  expect(f.state.visible).toBe(false)
  expect(f.state.bounds).toEqual({ x: 4, y: 40, width: 1152, height: 642 })
  dispose()
  await f.controller.close()
})

it('restores the original hidden frame when its paint pulse fails', async () => {
  const f = createOwnedBrowserCaptureFixture()
  f.properties.viewportWidth = 1
  f.properties.viewportHeight = 1
  f.guest.capturePage.mockRejectedValueOnce(new Error('native pulse failed'))
  const coordinator = new DesktopOwnedBrowserCapture()
  const dispose = coordinator.register(f.controller, f.owner)
  const route = getDesktopOwnedBrowserCapture(f.record.webContents)
  if (!route) {
    throw new Error('Owned capture route missing')
  }
  await expect(
    route({ kind: 'screenshot', params: { format: 'png', captureBeyondViewport: false } }, noHold)
  ).rejects.toThrow('native pulse failed')
  expect(f.properties.viewportWidth).toBe(1)
  expect(f.properties.viewportHeight).toBe(1)
  expect(f.captures).toHaveLength(0)
  await f.controller.updateLayout({ x: 1, y: 2, width: 600, height: 400 }, false)
  dispose()
  await f.controller.close()
})

it('retains an unanswered restoration, fences queued reuse after settlement, and permits exact guest close', async () => {
  vi.useFakeTimers()
  const f = createOwnedBrowserCaptureFixture()
  f.properties.viewportWidth = 1
  f.properties.viewportHeight = 1
  const coordinator = new DesktopOwnedBrowserCapture()
  const dispose = coordinator.register(f.controller, f.owner)
  const restore = deferred<unknown>()
  const send = f.sendCommand.getMockImplementation()!
  f.sendCommand.mockImplementation((method, params) =>
    method === 'Emulation.setVisibleSize' && params?.width === 1
      ? restore.promise.then(() => send(method, params))
      : send(method, params)
  )
  const route = getDesktopOwnedBrowserCapture(f.record.webContents)
  if (!route) {
    throw new Error('Owned capture route missing')
  }
  const capture = route(
    { kind: 'screenshot', params: { format: 'png', captureBeyondViewport: false } },
    noHold
  )
  const rejected = expect(capture).rejects.toThrow(
    'Timed out while running Emulation.setVisibleSize'
  )
  await vi.advanceTimersByTimeAsync(0)
  const bounds = { ...f.state.bounds }
  const layout = f.controller.updateLayout({ x: 1, y: 2, width: 600, height: 400 }, false)
  const fenced = expect(layout).rejects.toThrow('fenced')
  await vi.advanceTimersByTimeAsync(8000)
  expect(browserCaptureIdle.isIdle(f.record.webContents)).toBe(false)
  expect(f.state.bounds).toEqual(bounds)
  restore.resolve({})
  await rejected
  await fenced
  expect(f.state.bounds).toEqual(bounds)
  dispose()
  await f.controller.close()
  expect(f.guest.destroyed).toBe(true)
})
