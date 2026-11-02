import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const recordCoalescedDurableCrashBreadcrumb = vi.fn()
vi.mock('../crash-reporting/durable-crash-breadcrumb', () => ({
  recordCoalescedDurableCrashBreadcrumb: (...args: unknown[]) =>
    recordCoalescedDurableCrashBreadcrumb(...args)
}))

import { trackRendererLivenessAtDeath } from './renderer-liveness-at-death'

function createWindow(state: { minimized?: boolean; visible?: boolean; destroyed?: boolean } = {}) {
  const contents = new EventEmitter()
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => state.destroyed === true,
    isMinimized: () => state.minimized === true,
    isVisible: () => state.visible !== false,
    isFocused: () => false
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tracker only reads the emitter API and the four getters stubbed above.
  return { window: window as unknown as Electron.BrowserWindow, contents }
}

const MAIN_FRAME_NAVIGATION = { isMainFrame: true, isSameDocument: false }

describe('trackRendererLivenessAtDeath', () => {
  let now = 0
  beforeEach(() => {
    now = 1_000
    recordCoalescedDurableCrashBreadcrumb.mockClear()
  })

  it('reports how long the renderer has been hung, and clears it on responsive', () => {
    const { window, contents } = createWindow({ minimized: true })
    const tracker = trackRendererLivenessAtDeath(window, () => now)
    contents.emit('did-finish-load')
    window.emit('unresponsive')
    now += 5_000
    window.emit('unresponsive')
    now += 40_000

    expect(recordCoalescedDurableCrashBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'renderer_unresponsive' })
    )
    window.emit('responsive')
    expect(recordCoalescedDurableCrashBreadcrumb).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'renderer_responsive', data: { hungForMs: 45_000 } })
    )
    expect(tracker.takeAtRendererGone().rendererUnresponsiveForMs).toBeUndefined()

    window.emit('unresponsive')
    now += 30_000
    expect(tracker.takeAtRendererGone()).toMatchObject({
      rendererUnresponsiveForMs: 30_000,
      rendererDocumentLoaded: true,
      mainWindowState: 'minimized'
    })
  })

  it('does not carry a hang into the next document after a recovery reload', () => {
    const { window, contents } = createWindow()
    const tracker = trackRendererLivenessAtDeath(window, () => now)
    window.emit('unresponsive')
    contents.emit('did-start-navigation', MAIN_FRAME_NAVIGATION)

    expect(tracker.takeAtRendererGone().rendererUnresponsiveForMs).toBeUndefined()
  })

  it('reports a failed main-frame load as not loaded, though did-finish-load follows it', () => {
    const { window, contents } = createWindow()
    const tracker = trackRendererLivenessAtDeath(window, () => now)
    contents.emit('did-start-navigation', MAIN_FRAME_NAVIGATION)
    contents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///missing', true)
    contents.emit('did-finish-load')
    now += 12_000

    expect(tracker.takeAtRendererGone()).toMatchObject({
      rendererDocumentLoaded: false,
      rendererDocumentLoadFailed: true,
      rendererDocumentAgeMs: 12_000
    })
  })

  it('ignores aborted loads, subframe failures and same-document navigations', () => {
    const { window, contents } = createWindow()
    const tracker = trackRendererLivenessAtDeath(window, () => now)
    contents.emit('did-start-navigation', MAIN_FRAME_NAVIGATION)
    contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'file:///app', true)
    contents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///frame', false)
    contents.emit('did-finish-load')
    now += 5_000
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })

    const state = tracker.takeAtRendererGone()
    expect(state).toMatchObject({ rendererDocumentLoaded: true, rendererDocumentAgeMs: 5_000 })
    expect(state.rendererDocumentLoadFailed).toBeUndefined()
  })

  it('does not log the replacement renderer as the dead one recovering', () => {
    const { window, contents } = createWindow()
    const tracker = trackRendererLivenessAtDeath(window, () => now)
    contents.emit('did-finish-load')
    window.emit('unresponsive')
    now += 20_000
    expect(tracker.takeAtRendererGone().rendererUnresponsiveForMs).toBe(20_000)
    recordCoalescedDurableCrashBreadcrumb.mockClear()

    window.emit('responsive')

    expect(recordCoalescedDurableCrashBreadcrumb).not.toHaveBeenCalled()
  })
})
