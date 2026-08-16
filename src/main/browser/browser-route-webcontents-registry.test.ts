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
  let registry: BrowserRouteWebContentsRegistry
  registry = new BrowserRouteWebContentsRegistry({
    getPartitionForSession: (session) => (session === routeSession ? partition : null),
    getPreparedPageAuthority: (input) =>
      prepared &&
      input.partition === partition &&
      input.browserPageId === page.browserPageId &&
      input.pageHostGeneration === page.pageHostGeneration
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
    maxGuests: options.maxGuests
  })
  return {
    getPageAuthority: () => pageAuthority,
    registry,
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
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const eventListeners = listeners.get(event) ?? new Set()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)
    }),
    off: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(listener)
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

describe('BrowserRouteWebContentsRegistry', () => {
  it('holds navigation and popups until exact registration and an explicit grant', () => {
    const { registry, routeSession } = createHarness()
    const guest = createGuest({ session: routeSession })

    expect(registry.attachGuest(guest.guest)).toBe(true)
    const beforeRegistration = navigationEvent()
    guest.emit('will-navigate', beforeRegistration, 'https://example.com/')
    expect(beforeRegistration.preventDefault).toHaveBeenCalledOnce()
    expect(guest.openWindow()).toEqual({ action: 'deny' })

    expect(registry.registerGuest({ ...page, rendererWebContentsId: 12 })).toBe(false)
    expect(registry.grantNavigation(page)).toBe(false)
    expect(registry.registerGuest(page)).toBe(true)

    const beforeGrant = navigationEvent()
    guest.emit('will-navigate', beforeGrant, 'https://example.com/')
    expect(beforeGrant.preventDefault).toHaveBeenCalledOnce()

    expect(registry.grantNavigation(page)).toBe(true)
    const afterGrant = navigationEvent()
    guest.emit('will-navigate', afterGrant, 'https://example.com/')
    expect(afterGrant.preventDefault).not.toHaveBeenCalled()
    guest.setUrl('https://example.com/')
    const laterNavigation = navigationEvent()
    guest.emit('will-navigate', laterNavigation, 'https://example.org/')
    expect(laterNavigation.preventDefault).not.toHaveBeenCalled()
    expect(guest.openWindow()).toEqual({ action: 'deny' })
  })

  it('allows blank navigation while quarantined but blocks invalid schemes after a grant', () => {
    const { registry, routeSession } = createHarness()
    const guest = createGuest({ session: routeSession })
    registry.attachGuest(guest.guest)

    const blank = navigationEvent()
    guest.emit('will-navigate', blank, 'about:blank')
    expect(blank.preventDefault).not.toHaveBeenCalled()

    expect(registry.registerGuest(page)).toBe(true)
    expect(registry.grantNavigation(page)).toBe(true)
    const localFile = navigationEvent()
    guest.emit('will-navigate', localFile, 'file:///etc/passwd')
    expect(localFile.preventDefault).toHaveBeenCalledOnce()
  })

  it('destroys invalid route guests but ignores unrelated browser sessions', () => {
    const { registry, routeSession } = createHarness()
    const unrelated = createGuest({
      session: { marker: 'profile-session' } as unknown as Session
    })
    expect(registry.attachGuest(unrelated.guest)).toBe(false)
    expect(unrelated.guest.close).not.toHaveBeenCalled()

    for (const invalid of [
      createGuest({ session: routeSession, type: 'window' }),
      createGuest({ session: routeSession, url: 'https://example.com/' }),
      createGuest({ session: routeSession, rendererWebContentsId: 0 })
    ]) {
      expect(registry.attachGuest(invalid.guest)).toBe(false)
      expect(invalid.guest.close).toHaveBeenCalledOnce()
    }
    const alreadyDestroyed = createGuest({ session: routeSession, destroyed: true })
    expect(registry.attachGuest(alreadyDestroyed.guest)).toBe(false)
    expect(alreadyDestroyed.guest.close).not.toHaveBeenCalled()
  })

  it('bounds unregistered route guests and destroys excess attachments', () => {
    const { registry, routeSession } = createHarness({ maxGuests: 1 })
    const first = createGuest({ session: routeSession })
    const second = createGuest({ id: 42, session: routeSession })

    expect(registry.attachGuest(first.guest)).toBe(true)
    expect(registry.attachGuest(second.guest)).toBe(false)
    expect(second.guest.close).toHaveBeenCalledOnce()
  })

  it('keeps delayed or failed admission closure navigation- and popup-denied', () => {
    const { registry, routeSession } = createHarness({ maxGuests: 1 })
    registry.attachGuest(createGuest({ session: routeSession }).guest)
    for (const rejected of [
      createGuest({ id: 42, session: routeSession, closeDestroys: false }),
      createGuest({ id: 43, session: routeSession, closeError: new Error('close failed') })
    ]) {
      expect(registry.attachGuest(rejected.guest)).toBe(false)
      const navigation = navigationEvent()
      rejected.emit('will-navigate', navigation, 'https://example.com/')
      expect(navigation.preventDefault).toHaveBeenCalledOnce()
      expect(rejected.openWindow()).toEqual({ action: 'deny' })
    }
  })

  it('rejects page conflicts and stale destroyed callbacks cannot retire a replacement', () => {
    const { registry, replaceAuthority, routeSession } = createHarness()
    const first = createGuest({ session: routeSession })
    registry.attachGuest(first.guest)
    expect(registry.registerGuest(page)).toBe(true)

    const conflicting = createGuest({ id: 42, session: routeSession })
    registry.attachGuest(conflicting.guest)
    expect(registry.registerGuest({ ...page, webContentsId: 42 })).toBe(false)

    first.destroy()
    replaceAuthority()
    expect(registry.registerGuest({ ...page, webContentsId: 42 })).toBe(true)
    first.emit('destroyed')
    expect(registry.grantNavigation({ ...page, webContentsId: 42 })).toBe(true)
    expect(first.guest.off).toHaveBeenCalledWith('will-navigate', expect.any(Function))
    expect(first.guest.off).toHaveBeenCalledWith('will-redirect', expect.any(Function))
    expect(first.guest.off).toHaveBeenCalledWith('destroyed', expect.any(Function))
  })

  it('revokes navigation immediately when the logical page is no longer prepared', () => {
    const { registry, routeSession, setPrepared } = createHarness()
    const guest = createGuest({ session: routeSession })
    registry.attachGuest(guest.guest)
    registry.registerGuest(page)
    registry.grantNavigation(page)
    setPrepared(false)

    const afterRelease = navigationEvent()
    guest.emit('will-redirect', afterRelease, 'https://example.com/', false, true)
    expect(afterRelease.preventDefault).toHaveBeenCalledOnce()
  })

  it('quarantines a late attachment after its logical page authority is released', () => {
    const { registry, routeSession, setPrepared } = createHarness()
    setPrepared(false)
    const guest = createGuest({ session: routeSession })

    expect(registry.attachGuest(guest.guest)).toBe(true)
    expect(registry.registerGuest(page)).toBe(false)
    const navigation = navigationEvent()
    guest.emit('will-navigate', navigation, 'https://example.com/')
    expect(navigation.preventDefault).toHaveBeenCalledOnce()
    expect(guest.openWindow()).toEqual({ action: 'deny' })
  })

  it('does not retain mutable registration input as page authority', () => {
    const { registry, routeSession } = createHarness()
    const guest = createGuest({ session: routeSession })
    const registration = { ...page }
    registry.attachGuest(guest.guest)

    expect(registry.registerGuest(registration)).toBe(true)
    registration.browserPageId = 'mutated-page'
    expect(registry.grantNavigation(page)).toBe(true)
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

  it('holds page retirement until a close-delayed exact guest is destroyed', () => {
    const { getPageAuthority, registry, routeSession } = createHarness()
    const guest = createGuest({ session: routeSession, closeDestroys: false })
    const retired = vi.fn()
    registry.attachGuest(guest.guest)
    registry.registerGuest(page)
    registry.grantNavigation(page)

    expect(
      registry.retirePageAuthority({
        partition,
        browserPageId: page.browserPageId,
        pageHostGeneration: page.pageHostGeneration,
        pageAuthority: getPageAuthority(),
        onRetired: retired
      })
    ).toBe(false)
    const navigation = navigationEvent()
    guest.emit('will-navigate', navigation, 'https://example.com/')
    expect(navigation.preventDefault).toHaveBeenCalledOnce()
    expect(registry.grantNavigation(page)).toBe(false)
    expect(retired).not.toHaveBeenCalled()
    const duplicateRetired = vi.fn()
    expect(
      registry.retirePageAuthority({
        partition,
        browserPageId: page.browserPageId,
        pageHostGeneration: page.pageHostGeneration,
        pageAuthority: getPageAuthority(),
        onRetired: duplicateRetired
      })
    ).toBe(false)

    guest.destroy()
    expect(retired).toHaveBeenCalledOnce()
    expect(duplicateRetired).not.toHaveBeenCalled()
  })

  it('ignores retirement for a different opaque authority', () => {
    const { registry, routeSession } = createHarness()
    const guest = createGuest({ session: routeSession })
    registry.attachGuest(guest.guest)
    registry.registerGuest(page)
    registry.grantNavigation(page)

    expect(
      registry.retirePageAuthority({
        partition,
        browserPageId: page.browserPageId,
        pageHostGeneration: page.pageHostGeneration,
        pageAuthority: Symbol('wrong-authority'),
        onRetired: vi.fn()
      })
    ).toBe(true)
    expect(guest.guest.close).not.toHaveBeenCalled()
    const navigation = navigationEvent()
    guest.emit('will-navigate', navigation, 'https://example.com/')
    expect(navigation.preventDefault).not.toHaveBeenCalled()
  })

  it('does not settle retirement when destroyed inspection is unavailable', () => {
    const { getPageAuthority, registry, routeSession } = createHarness()
    const guest = createGuest({ session: routeSession, closeDestroys: false })
    const retired = vi.fn()
    registry.attachGuest(guest.guest)
    registry.registerGuest(page)
    registry.grantNavigation(page)
    vi.mocked(guest.guest.isDestroyed).mockImplementation(() => {
      throw new Error('inspection unavailable')
    })

    expect(
      registry.retirePageAuthority({
        partition,
        browserPageId: page.browserPageId,
        pageHostGeneration: page.pageHostGeneration,
        pageAuthority: getPageAuthority(),
        onRetired: retired
      })
    ).toBe(false)
    expect(retired).not.toHaveBeenCalled()
    const navigation = navigationEvent()
    guest.emit('will-navigate', navigation, 'https://example.com/')
    expect(navigation.preventDefault).toHaveBeenCalledOnce()

    guest.destroy()
    expect(retired).toHaveBeenCalledOnce()
  })

  it('retires the exact page authority when its guest process exits', () => {
    const { registry, routeSession } = createHarness()
    const guest = createGuest({ session: routeSession, closeDestroys: false })
    registry.attachGuest(guest.guest)
    registry.registerGuest(page)
    registry.grantNavigation(page)

    guest.emit('render-process-gone', {}, { reason: 'crashed' })

    expect(guest.guest.close).toHaveBeenCalledOnce()
    expect(registry.grantNavigation(page)).toBe(false)
    const navigation = navigationEvent()
    guest.emit('will-navigate', navigation, 'https://example.com/')
    expect(navigation.preventDefault).toHaveBeenCalledOnce()
  })

  it('retires every page owned by a crashed host renderer', () => {
    const { registry, routeSession } = createHarness()
    const first = createGuest({ session: routeSession })
    const unregisteredSibling = createGuest({ id: 42, session: routeSession })
    const unrelated = createGuest({ id: 43, rendererWebContentsId: 12, session: routeSession })
    registry.attachGuest(first.guest)
    registry.registerGuest(page)
    registry.grantNavigation(page)
    registry.attachGuest(unregisteredSibling.guest)
    registry.attachGuest(unrelated.guest)

    registry.retireRenderer(page.rendererWebContentsId)

    expect(first.guest.close).toHaveBeenCalledOnce()
    expect(unregisteredSibling.guest.close).toHaveBeenCalledOnce()
    expect(unrelated.guest.close).not.toHaveBeenCalled()
    expect(registry.grantNavigation(page)).toBe(false)
  })

  it('fails closed when Electron guest inspection races destruction', () => {
    const { registry, routeSession } = createHarness()
    const guest = createGuest({ session: routeSession })
    vi.mocked(guest.guest.getURL).mockImplementation(() => {
      throw new Error('guest destroyed')
    })

    expect(() => registry.attachGuest(guest.guest)).not.toThrow()
    expect(guest.guest.close).toHaveBeenCalledOnce()
  })

  it('turns registration-time inspection failures into navigation denial', () => {
    const { registry, routeSession } = createHarness()
    const guest = createGuest({ session: routeSession })
    registry.attachGuest(guest.guest)
    registry.registerGuest(page)
    registry.grantNavigation(page)
    vi.mocked(guest.guest.getType).mockImplementation(() => {
      throw new Error('guest swapped')
    })

    const navigation = navigationEvent()
    expect(() => guest.emit('will-navigate', navigation, 'https://example.com/')).not.toThrow()
    expect(navigation.preventDefault).toHaveBeenCalledOnce()
  })

  it('rejects registration without throwing when blank-document inspection fails', () => {
    const { registry, routeSession } = createHarness()
    const guest = createGuest({ session: routeSession })
    registry.attachGuest(guest.guest)
    vi.mocked(guest.guest.getURL).mockImplementation(() => {
      throw new Error('guest unavailable')
    })

    expect(() => registry.registerGuest(page)).not.toThrow()
    expect(registry.registerGuest(page)).toBe(false)
  })
})
