import type { Session, WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

const popupMocks = vi.hoisted(() => ({ openPopupWithOriginBar: vi.fn() }))

vi.mock('./popup-origin-bar-window', () => ({
  openPopupWithOriginBar: popupMocks.openPopupWithOriginBar
}))

import {
  resetBrowserRouteGuestPopupOwnership,
  resolveBrowserRouteGuestPopupOpener
} from './browser-route-guest-popup-ownership'
import { BrowserRouteWebContentsRegistry } from './browser-route-webcontents-registry'

const GESTURE_CLICK_AT = 1_700_000_000_000
const partition = `persist:orca-browser-v1-${'a'.repeat(64)}`
const otherPartition = `persist:orca-browser-v1-${'b'.repeat(64)}`
const page = {
  partition,
  browserPageId: 'page-a',
  pageHostGeneration: 7,
  webContentsId: 41,
  rendererWebContentsId: 11
}

afterEach(() => {
  resetBrowserRouteGuestPopupOwnership()
  vi.useRealTimers()
})

describe('route guest OAuth popups', () => {
  it('denies window.open without a recognized user gesture', () => {
    const { guest } = attachRegisteredGuest()

    expect(guest.openWindow('https://accounts.example.com/oauth')).toEqual({ action: 'deny' })
    expect(popupMocks.openPopupWithOriginBar).not.toHaveBeenCalled()
  })

  it('allows one popup per gesture, bound to the opener partition, and never replays it', () => {
    const { guest, popups } = attachRegisteredGuest()
    guest.emitInput('mouseDown')

    const allowed = guest.openWindow('https://accounts.example.com/oauth')

    expect(allowed.action).toBe('allow')
    expect(allowed.overrideBrowserWindowOptions?.webPreferences?.partition).toBe(partition)
    expect(allowed.overrideBrowserWindowOptions?.webPreferences?.sandbox).toBe(true)
    const opened = allowed.createWindow?.(popupOptions(createPopupContents()))
    expect(opened).not.toBeUndefined()
    expect(popups()).toHaveLength(1)
    expect(popups()[0]?.loaded).toBe(true)

    expect(guest.openWindow('https://accounts.example.com/oauth')).toEqual({ action: 'deny' })
  })

  // Literal offsets, not the exported constant: deriving them from it would keep a widened
  // gesture window green.
  it('still honors a gesture 1s after the click', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(GESTURE_CLICK_AT)
    const { guest } = attachRegisteredGuest()
    guest.emitInput('mouseDown')

    vi.setSystemTime(GESTURE_CLICK_AT + 1_000)

    expect(guest.openWindow('https://accounts.example.com/oauth').action).toBe('allow')
  })

  it('denies a popup more than 1s after the click that would have authorized it', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(GESTURE_CLICK_AT)
    const { guest } = attachRegisteredGuest()
    guest.emitInput('mouseDown')

    vi.setSystemTime(GESTURE_CLICK_AT + 1_001)

    expect(guest.openWindow('https://accounts.example.com/oauth')).toEqual({ action: 'deny' })
    expect(popupMocks.openPopupWithOriginBar).not.toHaveBeenCalled()
  })

  it('stops opening popups at the fourth one even while gestures keep arriving', () => {
    const { guest, popups } = attachRegisteredGuest()

    for (let index = 0; index < 4; index += 1) {
      guest.emitInput('mouseDown')
      const allowed = guest.openWindow(`https://accounts.example.com/oauth/${index}`)
      expect(allowed.action).toBe('allow')
      allowed.createWindow?.(popupOptions(createPopupContents()))
    }
    expect(popups()).toHaveLength(4)

    guest.emitInput('mouseDown')

    expect(guest.openWindow('https://accounts.example.com/oauth/overflow')).toEqual({
      action: 'deny'
    })
    expect(popups()).toHaveLength(4)
  })

  it('tells the owning page every popup it refused, and stays quiet once the page is gone', () => {
    const { guest, blockedPopups } = attachRegisteredGuest()

    guest.openWindow('https://accounts.example.com/oauth')
    guest.emitInput('mouseDown')
    guest.openWindow('file:///etc/hosts')

    expect(blockedPopups()).toEqual([
      { openerWebContentsId: page.webContentsId, url: 'https://accounts.example.com/oauth' },
      { openerWebContentsId: page.webContentsId, url: 'file:///etc/hosts' }
    ])

    guest.destroy()
    guest.openWindow('https://accounts.example.com/oauth')

    expect(blockedPopups()).toHaveLength(2)
  })

  it('applies the WebRTC policy before the popup can load and fails closed when it cannot', () => {
    const { guest, popups } = attachRegisteredGuest()
    guest.emitInput('mouseDown')
    const allowed = guest.openWindow('https://accounts.example.com/oauth')
    const contents = createPopupContents()

    allowed.createWindow?.(popupOptions(contents))

    expect(contents.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp')
    expect(popups()[0]?.order).toEqual(['webrtc-policy', 'load'])

    guest.emitInput('mouseDown')
    const second = guest.openWindow('https://accounts.example.com/oauth')
    second.createWindow?.(popupOptions(createPopupContents({ webRtcPolicyThrows: true })))

    expect(popups()[1]?.loaded).toBe(false)
    expect(popups()[1]?.closed).toBe(true)
  })

  it('fails closed when the popup contents land outside the opener partition', () => {
    const { guest, popups } = attachRegisteredGuest()
    guest.emitInput('mouseDown')
    const allowed = guest.openWindow('https://accounts.example.com/oauth')

    allowed.createWindow?.(popupOptions(createPopupContents({ partition: otherPartition })))

    expect(popups()[0]?.loaded).toBe(false)
    expect(popups()[0]?.closed).toBe(true)
  })

  it('refuses non-web destinations even with a real gesture', () => {
    const { guest } = attachRegisteredGuest()

    guest.emitInput('mouseDown')
    expect(guest.openWindow('file:///etc/hosts')).toEqual({ action: 'deny' })
    guest.emitInput('mouseDown')
    expect(guest.openWindow('about:blank')).toEqual({ action: 'deny' })
    expect(popupMocks.openPopupWithOriginBar).not.toHaveBeenCalled()
  })

  it('holds popups shut until the page is registered and navigation is granted', () => {
    const { registry, guest } = attachGuest()

    guest.emitInput('mouseDown')
    expect(guest.openWindow('https://accounts.example.com/oauth')).toEqual({ action: 'deny' })

    registry.registerGuest(page)
    guest.emitInput('mouseDown')
    expect(guest.openWindow('https://accounts.example.com/oauth')).toEqual({ action: 'deny' })

    registry.grantNavigation(page)
    guest.emitInput('mouseDown')
    expect(guest.openWindow('https://accounts.example.com/oauth').action).toBe('allow')
  })

  it('closes live popups when the opener page is fenced and reopens them once it is regranted', () => {
    const { registry, guest, popups } = attachRegisteredGuest()
    guest.emitInput('mouseDown')
    guest
      .openWindow('https://accounts.example.com/oauth')
      .createWindow?.(popupOptions(createPopupContents()))
    const claim = registry.claimGuestLifecycle(page)!

    expect(registry.revokeNavigation(claim)).toBe(true)

    expect(popups()[0]?.closed).toBe(true)
    guest.emitInput('mouseDown')
    expect(guest.openWindow('https://accounts.example.com/oauth')).toEqual({ action: 'deny' })

    expect(registry.grantReconciledNavigation(claim)).toBe(true)
    guest.emitInput('mouseDown')
    expect(guest.openWindow('https://accounts.example.com/oauth').action).toBe('allow')
  })

  it('closes popups and stops accepting new ones when the opener guest is destroyed', () => {
    const { guest, popups } = attachRegisteredGuest()
    guest.emitInput('mouseDown')
    guest
      .openWindow('https://accounts.example.com/oauth')
      .createWindow?.(popupOptions(createPopupContents()))

    guest.destroy()

    expect(popups()[0]?.closed).toBe(true)
    guest.emitInput('mouseDown')
    expect(guest.openWindow('https://accounts.example.com/oauth')).toEqual({ action: 'deny' })
  })

  it('owns popups by their opener page and drops ownership when the popup is destroyed', () => {
    const { guest } = attachRegisteredGuest()
    guest.emitInput('mouseDown')
    const contents = createPopupContents()
    guest.openWindow('https://accounts.example.com/oauth').createWindow?.(popupOptions(contents))

    expect(resolveBrowserRouteGuestPopupOpener(contents.id)).toBe(page.webContentsId)

    contents.emitDestroyed()

    expect(resolveBrowserRouteGuestPopupOpener(contents.id)).toBeNull()
  })

  it('claims no ownership for a popup that failed the partition fence', () => {
    const { guest } = attachRegisteredGuest()
    guest.emitInput('mouseDown')
    const contents = createPopupContents({ partition: otherPartition })

    guest.openWindow('https://accounts.example.com/oauth').createWindow?.(popupOptions(contents))

    expect(resolveBrowserRouteGuestPopupOpener(contents.id)).toBeNull()
  })

  it('drops popup ownership when the opener guest goes away', () => {
    const { guest } = attachRegisteredGuest()
    guest.emitInput('mouseDown')
    const contents = createPopupContents()
    guest.openWindow('https://accounts.example.com/oauth').createWindow?.(popupOptions(contents))
    guest.emitInput('mouseDown')
    const descendant = createPopupContents()
    contents.openWindow('https://accounts.example.com/step-2')
    contents.emitInput('mouseDown')
    contents
      .openWindow('https://accounts.example.com/step-2')
      .createWindow?.(popupOptions(descendant))
    // Descendants belong to the root page, not to the popup that opened them.
    expect(resolveBrowserRouteGuestPopupOpener(descendant.id)).toBe(page.webContentsId)

    guest.destroy()

    expect(resolveBrowserRouteGuestPopupOpener(contents.id)).toBeNull()
    expect(resolveBrowserRouteGuestPopupOpener(descendant.id)).toBeNull()
  })

  it('gives popup descendants the same gesture-gated handler', () => {
    const { guest } = attachRegisteredGuest()
    guest.emitInput('mouseDown')
    const contents = createPopupContents()
    guest.openWindow('https://accounts.example.com/oauth').createWindow?.(popupOptions(contents))

    expect(contents.openWindow('https://accounts.example.com/step-2')).toEqual({ action: 'deny' })
    contents.emitInput('mouseDown')
    expect(contents.openWindow('https://accounts.example.com/step-2').action).toBe('allow')
  })
})

function popupOptions(
  contents: ReturnType<typeof createPopupContents>
): Electron.BrowserWindowConstructorOptions {
  return { webContents: contents } as unknown as Electron.BrowserWindowConstructorOptions
}

type OpenedPopup = { order: string[]; loaded: boolean; closed: boolean }

function attachGuest() {
  popupMocks.openPopupWithOriginBar.mockReset()
  const opened: OpenedPopup[] = []
  popupMocks.openPopupWithOriginBar.mockImplementation(
    (
      options: { webContents?: ReturnType<typeof createPopupContents> },
      _url: string,
      prepareContent: (contents: WebContents) => boolean
    ) => {
      const contents = options.webContents!
      const record: OpenedPopup = { order: contents.order, loaded: false, closed: false }
      opened.push(record)
      const closedListeners: (() => void)[] = []
      const prepared = prepareContent(contents as unknown as WebContents)
      if (prepared) {
        contents.order.push('load')
        record.loaded = true
      } else {
        record.closed = true
      }
      return {
        contentWebContents: contents,
        close: () => {
          record.closed = true
          for (const listener of closedListeners.splice(0)) {
            listener()
          }
        },
        onClosed: (listener: () => void) => {
          if (record.closed) {
            listener()
            return
          }
          closedListeners.push(listener)
        }
      }
    }
  )
  const routeSession = { marker: 'route-session' } as unknown as Session
  const pageAuthority = Symbol('page-authority')
  const blocked: { openerWebContentsId: number; url: string }[] = []
  let prepared = true
  const registry = new BrowserRouteWebContentsRegistry({
    reportBlockedPopup: (input) => {
      blocked.push(input)
    },
    getPartitionForSession: (session) =>
      session === routeSession
        ? partition
        : ((session as unknown as { partition?: string }).partition ?? null),
    getPreparedPageAuthority: (input) =>
      prepared && input.browserPageId === page.browserPageId ? pageAuthority : null,
    retirePreparedPage: () => {
      prepared = false
      return true
    },
    retirePreparedPagesOwnedByRenderer: () => 0
  })
  const guest = createRouteGuest(routeSession)
  expect(registry.attachGuest(guest.guest)).toBe(true)
  return { registry, guest, popups: () => opened, blockedPopups: () => blocked }
}

function attachRegisteredGuest() {
  const harness = attachGuest()
  expect(harness.registry.registerGuest(page)).toBe(true)
  expect(harness.registry.grantNavigation(page)).toBe(true)
  return harness
}

function createRouteGuest(session: Session) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  let destroyed = false
  let windowOpenHandler: ((details: { url: string }) => Electron.WindowOpenHandlerResponse) | null =
    null
  const guest = {
    id: page.webContentsId,
    session,
    hostWebContents: { id: page.rendererWebContentsId },
    getType: () => 'webview',
    getURL: () => 'about:blank',
    isDestroyed: () => destroyed,
    close: () => {
      destroyed = true
    },
    loadURL: async () => {},
    on: (event: string, listener: (...args: unknown[]) => void) => {
      const bucket = listeners.get(event) ?? new Set()
      bucket.add(listener)
      listeners.set(event, bucket)
    },
    off: (event: string, listener: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(listener)
    },
    setWebRTCIPHandlingPolicy: vi.fn(),
    setWindowOpenHandler: (
      handler: (details: { url: string }) => Electron.WindowOpenHandlerResponse
    ) => {
      windowOpenHandler = handler
    }
  }
  return {
    guest: guest as unknown as WebContents,
    emitInput: (type: string) => {
      for (const listener of listeners.get('input-event') ?? []) {
        listener({}, { type })
      }
    },
    openWindow: (url: string) =>
      windowOpenHandler?.({ url }) ?? ({ action: 'deny' } as Electron.WindowOpenHandlerResponse),
    destroy: () => {
      destroyed = true
      for (const listener of listeners.get('destroyed') ?? []) {
        listener()
      }
    }
  }
}

let nextPopupWebContentsId = 900

function createPopupContents(options: { partition?: string; webRtcPolicyThrows?: boolean } = {}): {
  id: number
  order: string[]
  session: Session
  setWebRTCIPHandlingPolicy: ReturnType<typeof vi.fn>
  emitInput: (type: string) => void
  emitDestroyed: () => void
  openWindow: (url: string) => Electron.WindowOpenHandlerResponse
  isDestroyed: () => boolean
  close: () => void
  on: (event: string, listener: (...args: unknown[]) => void) => void
  off: (event: string, listener: (...args: unknown[]) => void) => void
  once: (event: string, listener: (...args: unknown[]) => void) => void
  setWindowOpenHandler: (
    handler: (details: { url: string }) => Electron.WindowOpenHandlerResponse
  ) => void
} {
  const order: string[] = []
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  let windowOpenHandler: ((details: { url: string }) => Electron.WindowOpenHandlerResponse) | null =
    null
  let destroyed = false
  const add = (event: string, listener: (...args: unknown[]) => void): void => {
    const bucket = listeners.get(event) ?? new Set()
    bucket.add(listener)
    listeners.set(event, bucket)
  }
  return {
    id: ++nextPopupWebContentsId,
    order,
    session: { partition: options.partition ?? partition } as unknown as Session,
    setWebRTCIPHandlingPolicy: vi.fn(() => {
      if (options.webRtcPolicyThrows) {
        throw new Error('policy unavailable')
      }
      order.push('webrtc-policy')
    }),
    emitInput: (type: string) => {
      for (const listener of listeners.get('input-event') ?? []) {
        listener({}, { type })
      }
    },
    emitDestroyed: () => {
      destroyed = true
      for (const listener of listeners.get('destroyed') ?? []) {
        listener()
      }
    },
    openWindow: (url: string) =>
      windowOpenHandler?.({ url }) ?? ({ action: 'deny' } as Electron.WindowOpenHandlerResponse),
    isDestroyed: () => destroyed,
    close: () => {
      destroyed = true
    },
    on: add,
    off: (event, listener) => {
      listeners.get(event)?.delete(listener)
    },
    once: add,
    setWindowOpenHandler: (handler) => {
      windowOpenHandler = handler
    }
  }
}
