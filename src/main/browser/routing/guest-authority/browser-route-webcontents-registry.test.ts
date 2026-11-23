import type { Session, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { BrowserRouteWebContentsRegistry } from './browser-route-webcontents-registry'

const partition = `persist:orca-browser-v1-${'a'.repeat(64)}`
const page = {
  partition,
  browserPageId: 'page-a',
  pageHostGeneration: 7,
  webContentsId: 41,
  rendererWebContentsId: 11
}

function createHarness(options: { maxGuests?: number } = {}) {
  const routeSession = { marker: 'route-session' } as unknown as Session
  let prepared = true
  let pageAuthority = Symbol('page-authority')
  const pageHostGeneration = page.pageHostGeneration
  const retirePreparedPagesOwnedByRenderer = vi.fn(() => 0)
  let registry: BrowserRouteWebContentsRegistry
  registry = new BrowserRouteWebContentsRegistry({
    getPartitionForSession: (session) => (session === routeSession ? partition : null),
    getPreparedPageAuthority: (input) =>
      prepared &&
      input.partition === partition &&
      input.browserPageId === page.browserPageId &&
      input.pageHostGeneration === pageHostGeneration &&
      input.rendererWebContentsId === page.rendererWebContentsId
        ? pageAuthority
        : null,
    retirePreparedPage: (input) => {
      if (input.pageAuthority !== pageAuthority) {
        return false
      }
      prepared = false
      registry.retirePageAuthority({ ...input, onRetired: vi.fn() })
      return true
    },
    retirePreparedPagesOwnedByRenderer,
    maxGuests: options.maxGuests
  })
  return {
    registry,
    retirePreparedPagesOwnedByRenderer,
    routeSession,
    setPrepared: (value: boolean) => {
      prepared = value
    },
    replaceAuthority: () => {
      prepared = true
      pageAuthority = Symbol('replacement-page-authority')
    }
  }
}

function createGuest(options: {
  id?: number
  session?: Session
  rendererWebContentsId?: number
  type?: string
  url?: string
  destroyed?: boolean
  closeDestroys?: boolean
  closeError?: Error
  webRtcPolicyError?: Error
}) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  let destroyed = options.destroyed ?? false
  let currentUrl = options.url ?? 'about:blank'
  let windowOpenHandler: (() => { action: 'deny' }) | null = null
  const guest = {
    id: options.id ?? page.webContentsId,
    session: options.session,
    hostWebContents: { id: options.rendererWebContentsId ?? page.rendererWebContentsId },
    getType: vi.fn(() => options.type ?? 'webview'),
    getURL: vi.fn(() => currentUrl),
    isDestroyed: vi.fn(() => destroyed),
    close: vi.fn(() => {
      if (options.closeError) {
        throw options.closeError
      }
      if (options.closeDestroys !== false) {
        destroyed = true
      }
    }),
    loadURL: vi.fn(async (url: string) => {
      currentUrl = url
    }),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const eventListeners = listeners.get(event) ?? new Set()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)
    }),
    off: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(listener)
    }),
    setWebRTCIPHandlingPolicy: vi.fn(() => {
      if (options.webRtcPolicyError) {
        throw options.webRtcPolicyError
      }
    }),
    setWindowOpenHandler: vi.fn((handler: () => { action: 'deny' }) => {
      windowOpenHandler = handler
    })
  }
  return {
    guest: guest as unknown as WebContents,
    emit: (event: string, ...args: unknown[]) => {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args)
      }
    },
    setUrl: (url: string) => {
      currentUrl = url
    },
    openWindow: () => windowOpenHandler?.(),
    destroy: () => {
      destroyed = true
      for (const listener of listeners.get('destroyed') ?? []) {
        listener()
      }
    }
  }
}

function navigationEvent(): { preventDefault: ReturnType<typeof vi.fn> } {
  return { preventDefault: vi.fn() }
}

function requireLifecycleClaim(registry: BrowserRouteWebContentsRegistry, registration = page) {
  const claim = registry.claimGuestLifecycle(registration)
  expect(claim).not.toBeNull()
  return claim!
}

describe('BrowserRouteWebContentsRegistry', () => {
  it('settles exact guest retirement only after its destroyed acknowledgement', async () => {
    const { registry, routeSession } = createHarness()
    const guest = createGuest({ session: routeSession, closeDestroys: false })
    registry.attachGuest(guest.guest)

    const retired = registry.beginGuestRetirement(requireLifecycleClaim(registry))
    let settled = false
    void retired?.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    guest.destroy()
    await expect(retired).resolves.toBeUndefined()
  })

  it('keeps policy-rejected guests quarantined through delayed or failed close', () => {
    const { registry, routeSession } = createHarness()
    for (const rejected of [
      createGuest({
        session: routeSession,
        closeDestroys: false,
        webRtcPolicyError: new Error('policy unavailable')
      }),
      createGuest({
        session: routeSession,
        closeError: new Error('close failed'),
        webRtcPolicyError: new Error('policy unavailable')
      })
    ]) {
      expect(registry.attachGuest(rejected.guest)).toBe(false)
      const navigation = navigationEvent()
      rejected.emit('will-navigate', navigation, 'https://example.com/')
      expect(navigation.preventDefault).toHaveBeenCalledOnce()
      expect(rejected.openWindow()).toEqual({ action: 'deny' })
    }
  })

  it('does not revive a stale guest when the same logical page tuple is prepared again', () => {
    const { registry, replaceAuthority, routeSession } = createHarness()
    const stale = createGuest({ session: routeSession })
    registry.attachGuest(stale.guest)
    registry.registerGuest(page)
    registry.grantNavigation(page)
    replaceAuthority()

    const staleNavigation = navigationEvent()
    stale.emit('will-navigate', staleNavigation, 'https://example.com/')
    expect(staleNavigation.preventDefault).toHaveBeenCalledOnce()
    expect(registry.registerGuest(page)).toBe(false)

    const replacement = createGuest({ id: 42, session: routeSession })
    expect(registry.attachGuest(replacement.guest)).toBe(true)
    expect(registry.registerGuest({ ...page, webContentsId: 42 })).toBe(true)
    expect(registry.grantNavigation({ ...page, webContentsId: 42 })).toBe(true)
  })
})
