import type { Session, WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

const popupMocks = vi.hoisted(() => ({ openPopupWithOriginBar: vi.fn() }))

vi.mock('../../guest-lifecycle/popups/presentation/popup-origin-bar-window', () => ({
  openPopupWithOriginBar: popupMocks.openPopupWithOriginBar
}))

import {
  resetBrowserRouteGuestPopupOwnership,
  resolveBrowserRouteGuestPopupOpener
} from './browser-route-guest-popup-ownership'
import { BrowserRouteWebContentsRegistry } from './browser-route-webcontents-registry'
const partition = `persist:orca-browser-v1-${'a'.repeat(64)}`
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
  // Pin elapsed times independently of the gesture-window constant to catch widening.

  it('spends a gesture on a denial and rechecks authority before adopting a child', () => {
    const { registry, guest, popups } = attachRegisteredGuest()
    guest.emitInput('mouseDown')
    expect(guest.openWindow('file:///etc/hosts')).toEqual({ action: 'deny' })
    expect(guest.openWindow('about:blank')).toEqual({ action: 'deny' })
    guest.emitInput('mouseDown')
    const allowed = guest.openWindow('about:blank')
    registry.revokeNavigation(registry.claimGuestLifecycle(page)!)
    allowed.createWindow?.(popupOptions(createPopupContents()))
    expect(popups()[0]?.loaded).toBe(false)
    expect(popups()[0]?.closed).toBe(true)
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
    expect(resolveBrowserRouteGuestPopupOpener(descendant.id)).toBe(page.webContentsId)

    guest.destroy()

    expect(resolveBrowserRouteGuestPopupOpener(contents.id)).toBeNull()
    expect(resolveBrowserRouteGuestPopupOpener(descendant.id)).toBeNull()
  })

  it('guards blank descendants and redirects after the root loses authority', () => {
    const { registry, guest } = attachRegisteredGuest()
    guest.emitInput('mouseDown')
    const contents = createPopupContents()
    guest.openWindow('about:blank#state').createWindow?.(popupOptions(contents))
    expect(contents.navigate('about:blank#next')).toBe(false)
    expect(contents.navigate('about:blank?state=synthetic')).toBe(true)
    expect(contents.navigate('file:///etc/hosts', 'will-redirect')).toBe(true)
    contents.emitInput('mouseDown')
    expect(contents.openWindow('about:blank#next').action).toBe('allow')
    registry.revokeNavigation(registry.claimGuestLifecycle(page)!)
    expect(contents.navigate('about:blank#next')).toBe(true)
    contents.emitInput('mouseDown')
    expect(contents.openWindow('about:blank')).toEqual({ action: 'deny' })
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
  let windowOpenHandler:
    | ((details: {
        url: string
        postBody?: Electron.PostBody
      }) => Electron.WindowOpenHandlerResponse)
    | null = null
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
      handler: (details: {
        url: string
        postBody?: Electron.PostBody
      }) => Electron.WindowOpenHandlerResponse
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
    openWindow: (url: string, postBody?: Electron.PostBody): Electron.WindowOpenHandlerResponse =>
      windowOpenHandler?.({ url, postBody }) ?? { action: 'deny' },
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
  navigate: (url: string, event?: string) => boolean
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
    navigate: (url, event = 'will-navigate') => {
      let prevented = false
      for (const listener of listeners.get(event) ?? []) {
        listener(
          {
            preventDefault: () => {
              prevented = true
            }
          },
          url
        )
      }
      return prevented
    },
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
