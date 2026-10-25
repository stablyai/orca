import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'

// PR33112: passive per-page IPC must resolve the caller's own guest without moving the
// shared native-renderer selection that `browser:activeTabChanged` owns.
const contents = new Map<number, WebContents>()

vi.mock('electron', () => ({
  app: { getPath: () => '/downloads' },
  BrowserWindow: { fromWebContents: () => null },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() },
  Menu: { buildFromTemplate: () => ({ popup: vi.fn() }) },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  ipcMain: {
    handlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
    handle(channel: string, handler: (event: unknown, args: unknown) => unknown) {
      this.handlers.set(channel, handler)
    },
    removeHandler(channel: string) {
      this.handlers.delete(channel)
    },
    removeAllListeners(channel: string) {
      this.handlers.delete(channel)
    },
    on(channel: string, handler: (event: unknown, args: unknown) => unknown) {
      this.handlers.set(channel, handler)
    }
  },
  webContents: { fromId: (id: number) => contents.get(id) ?? null }
}))

class NativeRenderer extends EventEmitter {
  send = vi.fn()
  private destroyed = false
  constructor(readonly id: number) {
    super()
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  getType(): string {
    return 'window'
  }
  getURL(): string {
    return 'file:///renderer/index.html'
  }
  asWebContents(): WebContents {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture exposes the WebContents members the registry and IPC handlers exercise.
    return this as unknown as WebContents
  }
}

class NativeGuest extends EventEmitter {
  private destroyed = false
  constructor(readonly id: number) {
    super()
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  getType(): string {
    return 'webview'
  }
  getURL(): string {
    return 'https://example.test'
  }
  setBackgroundThrottling(): void {}
  setWindowOpenHandler(): void {}
  getZoomLevel(): number {
    return 0
  }
  setZoomLevel(): void {}
  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
  asWebContents(): WebContents {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture exposes the WebContents members guest registration and the site display controller read.
    return this as unknown as WebContents
  }
}

import { ipcMain } from 'electron'
import { registerBrowserGuestViewHandlers } from './browser-guest-view-ipc'
import { registerBrowserHandlers, setAgentBrowserBridgeRef } from './browser'
import { browserManager } from '../browser/browser-manager'
import { browserSiteDisplayController } from '../browser/browser-site-display-controller'
import {
  registerDesktopRenderer,
  unregisterDesktopRenderer
} from '../window/desktop-renderer-registry'

browserManager.setSiteDisplayController(browserSiteDisplayController)

type Handler = (event: { sender: WebContents }, args: unknown) => unknown

function handlers(): Map<string, Handler> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test's ipcMain mock records handlers exactly as registerBrowserGuestViewHandlers/registerBrowserHandlers hand them.
  return (ipcMain as unknown as { handlers: Map<string, Handler> }).handlers
}

function fixture(): {
  rendererA: NativeRenderer
  rendererB: NativeRenderer
  guestA: NativeGuest
  guestB: NativeGuest
} {
  const rendererA = new NativeRenderer(9001)
  const rendererB = new NativeRenderer(9002)
  for (const renderer of [rendererA, rendererB]) {
    contents.set(renderer.id, renderer.asWebContents())
    registerDesktopRenderer(renderer.asWebContents(), `native-window-${renderer.id}`)
  }
  const guestA = new NativeGuest(201)
  const guestB = new NativeGuest(202)
  for (const [guest, renderer] of [
    [guestA, rendererA],
    [guestB, rendererB]
  ] as const) {
    contents.set(guest.id, guest.asWebContents())
    browserManager.attachGuestPolicies(guest.asWebContents())
    expect(
      browserManager.registerGuest({
        browserPageId: 'shared-page',
        workspaceId: 'workspace',
        worktreeId: 'worktree',
        webContentsId: guest.id,
        rendererWebContentsId: renderer.id
      })
    ).toBe(true)
  }
  return { rendererA, rendererB, guestA, guestB }
}

afterEach(() => {
  browserManager.unregisterAll()
  for (const renderer of contents.values()) {
    unregisterDesktopRenderer(renderer)
  }
  contents.clear()
  handlers().clear()
  setAgentBrowserBridgeRef(null)
})

describe('native multi-window guest-view IPC scoping', () => {
  it('preserves the selected middle peer when a third window closes its guest', () => {
    const { rendererB, guestA, guestB } = fixture()
    const rendererC = new NativeRenderer(9003)
    const guestC = new NativeGuest(203)
    contents.set(rendererC.id, rendererC.asWebContents())
    contents.set(guestC.id, guestC.asWebContents())
    registerDesktopRenderer(rendererC.asWebContents(), 'native-window-c')
    browserManager.attachGuestPolicies(guestC.asWebContents())
    expect(
      browserManager.registerGuest({
        browserPageId: 'shared-page',
        workspaceId: 'workspace',
        worktreeId: 'worktree',
        webContentsId: guestC.id,
        rendererWebContentsId: rendererC.id
      })
    ).toBe(true)
    browserManager.selectNativeRenderer(rendererB.id)
    expect(browserManager.unregisterGuestForRenderer('shared-page', rendererC.id)).toBe(true)
    expect(browserManager.getGuestWebContentsId('shared-page')).toBe(guestB.id)
    expect(browserManager.getManagedBrowserGuestContext(guestA.id)).not.toBeNull()
    expect(browserManager.getManagedBrowserGuestContext(guestB.id)).not.toBeNull()
  })

  it('keeps the selected peer when DevTools finds the requesting window guest stale', async () => {
    const { rendererA, rendererB, guestA, guestB } = fixture()
    browserManager.selectNativeRenderer(rendererA.id)
    contents.delete(guestB.id)
    expect(await browserManager.openDevTools('shared-page', undefined, rendererB.id)).toBe(false)
    expect(browserManager.getGuestWebContentsId('shared-page')).toBe(guestA.id)
    expect(browserManager.getManagedBrowserGuestContext(guestA.id)).not.toBeNull()
  })

  it('leaves A selected after a passive query from B and returns the B guest state', () => {
    const { rendererA, rendererB, guestA } = fixture()
    // A is the currently selected guest for the shared page.
    browserManager.selectNativeRenderer(rendererA.id)
    expect(browserManager.getGuestWebContentsId('shared-page')).toBe(guestA.id)

    registerBrowserGuestViewHandlers()
    const getPageSiteDisplay = handlers().get('browser:getPageSiteDisplay')
    if (!getPageSiteDisplay) {
      throw new Error('browser:getPageSiteDisplay not registered')
    }

    // B passively queries its own page's display state.
    const displayForB = getPageSiteDisplay(
      { sender: rendererB.asWebContents() },
      {
        browserPageId: 'shared-page'
      }
    )
    expect(displayForB).not.toBeNull()

    // The passive query from B must not have moved the shared selection toward B.
    expect(browserManager.getGuestWebContentsId('shared-page')).toBe(guestA.id)

    // A's own passive query still resolves to A's guest, unaffected by B's call.
    const displayForA = getPageSiteDisplay(
      { sender: rendererA.asWebContents() },
      {
        browserPageId: 'shared-page'
      }
    )
    expect(displayForA).not.toBeNull()
  })

  it('confirms isGuestRegistered against the caller guest independently of selection', () => {
    const { rendererA, rendererB, guestA, guestB } = fixture()
    browserManager.selectNativeRenderer(rendererA.id)

    registerBrowserHandlers()
    const isGuestRegistered = handlers().get('browser:isGuestRegistered')
    if (!isGuestRegistered) {
      throw new Error('browser:isGuestRegistered not registered')
    }

    // B asks about its own guest even though A is currently selected.
    expect(
      isGuestRegistered(
        { sender: rendererB.asWebContents() },
        { browserPageId: 'shared-page', webContentsId: guestB.id }
      )
    ).toBe(true)
    // B must not be told it owns A's guest.
    expect(
      isGuestRegistered(
        { sender: rendererB.asWebContents() },
        { browserPageId: 'shared-page', webContentsId: guestA.id }
      )
    ).toBe(false)
    // The passive check must not have moved the shared selection.
    expect(browserManager.getGuestWebContentsId('shared-page')).toBe(guestA.id)
  })

  it('still lets explicit activeTabChanged select B for both two-window ownership and a later single-window retention', () => {
    const { rendererA, rendererB, guestA, guestB } = fixture()
    browserManager.selectNativeRenderer(rendererA.id)
    expect(browserManager.getGuestWebContentsId('shared-page')).toBe(guestA.id)

    setAgentBrowserBridgeRef({
      onProcessSwap: vi.fn(async () => {}),
      onTabClosed: vi.fn(async () => {}),
      onTabChanged: vi.fn()
    })
    registerBrowserHandlers()
    const activeTabChanged = handlers().get('browser:activeTabChanged')
    if (!activeTabChanged) {
      throw new Error('browser:activeTabChanged not registered')
    }

    expect(
      activeTabChanged({ sender: rendererB.asWebContents() }, { browserPageId: 'shared-page' })
    ).toBe(true)
    expect(browserManager.getGuestWebContentsId('shared-page')).toBe(guestB.id)

    // Retained single-window behavior: once A's guest is gone, B's remains selected and reachable.
    guestA.destroy()
    expect(browserManager.getGuestWebContentsId('shared-page')).toBe(guestB.id)
  })

  it('closes the B guest while leaving A selected and live', () => {
    const { rendererA, rendererB, guestA, guestB } = fixture()
    browserManager.selectNativeRenderer(rendererA.id)
    expect(browserManager.getGuestWebContentsId('shared-page')).toBe(guestA.id)

    registerBrowserHandlers()
    const unregisterGuest = handlers().get('browser:unregisterGuest')
    if (!unregisterGuest) {
      throw new Error('browser:unregisterGuest not registered')
    }

    expect(
      unregisterGuest({ sender: rendererB.asWebContents() }, { browserPageId: 'shared-page' })
    ).toBe(true)

    // A's guest must still be the one live and selected for the page.
    expect(browserManager.getGuestWebContentsId('shared-page')).toBe(guestA.id)
    expect(guestA.isDestroyed()).toBe(false)
    expect(browserManager.getManagedBrowserGuestContext(guestA.id)?.browserPageId).toBe(
      'shared-page'
    )
    // B's own guest is the one that was torn down.
    expect(browserManager.getManagedBrowserGuestContext(guestB.id)).toBeNull()
  })

  it('refuses unregister from a native renderer with no guest without touching its peer', () => {
    const { rendererA, rendererB, guestA } = fixture()
    browserManager.unregisterGuestForRenderer('shared-page', rendererB.id)
    browserManager.selectNativeRenderer(rendererA.id)
    const onTabClosed = vi.fn(async () => {})
    setAgentBrowserBridgeRef({
      onTabClosed,
      onProcessSwap: vi.fn(async () => {}),
      onTabChanged: vi.fn()
    })
    registerBrowserHandlers()

    expect(
      handlers().get('browser:unregisterGuest')?.(
        { sender: rendererB.asWebContents() },
        { browserPageId: 'shared-page' }
      )
    ).toBe(false)
    expect(onTabClosed).not.toHaveBeenCalled()
    expect(browserManager.getGuestWebContentsId('shared-page')).toBe(guestA.id)
    expect(guestA.isDestroyed()).toBe(false)
  })

  it('records the B scroll report without changing the A scroll state', () => {
    const { rendererA, rendererB, guestA, guestB } = fixture()
    browserManager.selectNativeRenderer(rendererA.id)

    registerBrowserGuestViewHandlers()
    const reportViewportScrollState = handlers().get('browser:reportViewportScrollState')
    if (!reportViewportScrollState) {
      throw new Error('browser:reportViewportScrollState not registered')
    }

    const aState = { scrollLeft: 10, scrollTop: 20, maxScrollLeft: 100, maxScrollTop: 200 }
    const bState = { scrollLeft: 30, scrollTop: 40, maxScrollLeft: 300, maxScrollTop: 400 }
    reportViewportScrollState(
      { sender: rendererA.asWebContents() },
      { browserPageId: 'shared-page', state: aState }
    )
    // B reports its own scroll state while A, not B, is the currently selected guest.
    reportViewportScrollState(
      { sender: rendererB.asWebContents() },
      { browserPageId: 'shared-page', state: bState }
    )

    const scrollStates: unknown = Reflect.get(browserManager, 'viewportScrollStatesByGuestId')
    if (!(scrollStates instanceof Map)) {
      throw new Error('Missing viewport scroll state map')
    }
    expect(scrollStates.get(guestA.id)).toEqual(aState)
    expect(scrollStates.get(guestB.id)).toEqual(bState)
  })
})
