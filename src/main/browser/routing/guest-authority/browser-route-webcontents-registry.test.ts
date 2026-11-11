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
  let pageHostGeneration = page.pageHostGeneration
  const retirePreparedPagesOwnedByRenderer = vi.fn(() => 0)
  const rekeyPreparedPage = vi.fn((previous, next) => {
    if (
      !prepared ||
      previous.pageAuthority !== pageAuthority ||
      previous.pageHostGeneration !== pageHostGeneration ||
      next.partition !== partition ||
      next.browserPageId !== page.browserPageId ||
      next.rendererWebContentsId !== page.rendererWebContentsId
    ) {
      return null
    }
    pageHostGeneration = next.pageHostGeneration
    return {
      page: { ...next, pageAuthority },
      routeSession: { partition, release: vi.fn() }
    }
  })
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
    rekeyPreparedPage,
    retirePreparedPagesOwnedByRenderer,
    maxGuests: options.maxGuests
  })
  return {
    getPageAuthority: () => pageAuthority,
    registry,
    rekeyPreparedPage,
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
  it('atomically rekeys the prepared page, guest index, lifecycle claim, and navigation grant', async () => {
    const { registry, rekeyPreparedPage, routeSession } = createHarness()
    const guest = createGuest({ session: routeSession })
    expect(registry.attachGuest(guest.guest)).toBe(true)
    expect(registry.registerGuest(page)).toBe(true)
    const previousClaim = requireLifecycleClaim(registry)
    expect(registry.grantNavigation(page)).toBe(true)
    await expect(
      registry.navigateGuest(previousClaim, 'https://before-rekey.internal/')
    ).resolves.toBe(true)
    expect(registry.revokeNavigation(previousClaim)).toBe(true)
    const next = { ...page, pageHostGeneration: 8 }

    const rekeyed = registry.rekeyGuestLifecycle(previousClaim, next)

    expect(rekeyed?.lifecycleClaim.registration).toEqual(next)
    expect(rekeyPreparedPage).toHaveBeenCalledOnce()
    expect(previousClaim.isCurrent()).toBe(false)
    expect(rekeyed?.lifecycleClaim.isCurrent()).toBe(true)
    expect(registry.grantReconciledNavigation(rekeyed!.lifecycleClaim)).toBe(true)
    await expect(registry.navigateGuest(previousClaim, 'https://stale.invalid/')).resolves.toBe(
      false
    )
    await expect(
      registry.navigateGuest(rekeyed!.lifecycleClaim, 'https://remote.internal/')
    ).resolves.toBe(true)
  })

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
        rendererWebContentsId: page.rendererWebContentsId,
        pageAuthority: getPageAuthority(),
        onRetired: retired
      })
    ).toBe(false)
    expect(registry.registerGuest(page)).toBe(false)
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
        rendererWebContentsId: page.rendererWebContentsId,
        pageAuthority: getPageAuthority(),
        onRetired: duplicateRetired
      })
    ).toBe(false)

    guest.destroy()
    expect(retired).toHaveBeenCalledOnce()
    expect(duplicateRetired).not.toHaveBeenCalled()
  })

  it('retires every page owned by a crashed host renderer', () => {
    const { registry, retirePreparedPagesOwnedByRenderer, routeSession } = createHarness()
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
    expect(retirePreparedPagesOwnedByRenderer).toHaveBeenCalledWith(page.rendererWebContentsId)
  })

  it('keeps a destroyed claim distinct from a reused WebContents identity', async () => {
    const { registry, replaceAuthority, routeSession } = createHarness()
    const first = createGuest({ session: routeSession })
    registry.attachGuest(first.guest)
    registry.registerGuest(page)
    const firstClaim = requireLifecycleClaim(registry)
    first.destroy()

    replaceAuthority()
    const replacement = createGuest({ session: routeSession })
    registry.attachGuest(replacement.guest)
    registry.registerGuest(page)
    registry.grantNavigation(page)
    const replacementClaim = requireLifecycleClaim(registry)

    await expect(registry.navigateGuest(firstClaim, 'https://stale.test')).resolves.toBe(false)
    await expect(registry.navigateGuest(replacementClaim, 'https://current.test')).resolves.toBe(
      true
    )
    await expect(registry.beginGuestRetirement(firstClaim)).resolves.toBeUndefined()
    expect(replacement.guest.close).not.toHaveBeenCalled()
    await expect(registry.beginGuestRetirement(replacementClaim)).resolves.toBeUndefined()
    expect(replacement.guest.close).toHaveBeenCalledOnce()
  })
})
