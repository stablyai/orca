import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { MobileWebNavigationIntent } from './mobile-web-navigation-intent-buffer'
import { MOBILE_WEB_NAVIGATION_INTENTS } from './mobile-web-navigation-intent-buffer'
import {
  mobileHomeDestination,
  mobileHomeHostStackTarget,
  mobileHostWorkspaceEntry,
  navigateFromMobileHome
} from './mobile-web-home-navigation'

let latestIntent: MobileWebNavigationIntent | null = null
const unsubscribe = MOBILE_WEB_NAVIGATION_INTENTS.subscribe((intent) => {
  latestIntent = intent
})

afterEach(() => {
  if (latestIntent) {
    MOBILE_WEB_NAVIGATION_INTENTS.consume(latestIntent.sequence)
  }
  latestIntent = null
})

describe('mobile web Home navigation', () => {
  it('hands a typed destination to the selected architecture route', () => {
    const router = { push: vi.fn() }

    navigateFromMobileHome({
      router,
      hostId: 'host',
      target: { kind: 'tasks', taskSource: 'linear' },
      nativeBaselineEnabled: false
    })

    expect(router.push).toHaveBeenCalledWith('/hybrid?hostId=host')
    expect(latestIntent).toMatchObject({
      source: 'home',
      hostId: 'host',
      target: { kind: 'tasks', taskSource: 'linear' }
    })
  })

  it('encodes the post-pairing hosted route identity', () => {
    expect(mobileHostWorkspaceEntry('host/key?', false)).toBe('/hybrid?hostId=host%2Fkey%3F')
    expect(mobileHostWorkspaceEntry('host/key?', true)).toBe('/h/host%2Fkey%3F')
  })

  it('routes every parity baseline target through native presentation source', () => {
    expect(mobileHomeDestination('host/key', { kind: 'workspaceList' }, true)).toBe('/h/host%2Fkey')
    expect(
      mobileHomeDestination(
        'host/key',
        { kind: 'session', hostWorkspaceId: 'repo::/workspace' },
        true
      )
    ).toBe('/h/host%2Fkey/session/repo%3A%3A%2Fworkspace')
    expect(mobileHomeDestination('host/key', { kind: 'tasks', taskSource: 'linear' }, true)).toBe(
      '/h/host%2Fkey/tasks?taskSource=linear'
    )
    expect(mobileHomeDestination('host/key', { kind: 'accounts' }, true)).toBe(
      '/h/host%2Fkey/accounts'
    )
    expect(mobileHomeDestination('host/key', { kind: 'newWorkspace' }, true)).toBe(
      '/h/host%2Fkey?action=newWorktree'
    )
    expect(
      mobileHomeDestination('host/key', { kind: 'workspaceList', notice: 'worktree-missing' }, true)
    ).toBe('/h/host%2Fkey?notice=worktree-missing')
  })

  it('coordinates the deep native routes instead of cold-pushing them', () => {
    // Why this matters: a cold push straight to a nested host route resolves to the host
    // index without the dynamic id, so HostProtocolGate mounts blank (#12001).
    for (const target of [
      { kind: 'session', hostWorkspaceId: 'repo::/workspace', name: 'Fix #1' },
      { kind: 'tasks', taskSource: 'linear' },
      { kind: 'accounts' }
    ] as const) {
      const router = { push: vi.fn() }
      const openHostStackRoute = vi.fn()

      navigateFromMobileHome({
        router,
        openHostStackRoute,
        hostId: 'host/one',
        target,
        nativeBaselineEnabled: true
      })

      expect(router.push).not.toHaveBeenCalled()
      expect(openHostStackRoute).toHaveBeenCalledWith(
        'host/one',
        mobileHomeHostStackTarget('host/one', target)
      )
    }
  })

  it('maps each deep intent onto its own host-stack screen, identities left raw', () => {
    expect(
      mobileHomeHostStackTarget('host/one', {
        kind: 'session',
        hostWorkspaceId: 'repo::/workspace',
        name: 'Fix #1'
      })
    ).toEqual({
      name: '[hostId]/session/[worktreeId]',
      params: { hostId: 'host/one', worktreeId: 'repo::/workspace', name: 'Fix #1' }
    })
    expect(mobileHomeHostStackTarget('host/one', { kind: 'tasks', taskSource: 'linear' })).toEqual({
      name: '[hostId]/tasks',
      params: { hostId: 'host/one', taskSource: 'linear' }
    })
    expect(mobileHomeHostStackTarget('host/one', { kind: 'accounts' })).toEqual({
      name: '[hostId]/accounts',
      params: { hostId: 'host/one' }
    })
    // The host index itself needs no coordination — a plain push already resolves it.
    expect(mobileHomeHostStackTarget('host/one', { kind: 'newWorkspace' })).toBeNull()
    expect(
      mobileHomeHostStackTarget('host/one', { kind: 'workspaceList', notice: 'worktree-missing' })
    ).toBeNull()
  })

  it('keeps host-index intents and the whole hybrid build on a plain push', () => {
    const nativeRouter = { push: vi.fn() }
    const nativeOpen = vi.fn()
    navigateFromMobileHome({
      router: nativeRouter,
      openHostStackRoute: nativeOpen,
      hostId: 'host/one',
      target: { kind: 'workspaceList', notice: 'worktree-missing' },
      nativeBaselineEnabled: true
    })
    expect(nativeOpen).not.toHaveBeenCalled()
    expect(nativeRouter.push).toHaveBeenCalledWith('/h/host%2Fone?notice=worktree-missing')

    const hybridRouter = { push: vi.fn() }
    const hybridOpen = vi.fn()
    navigateFromMobileHome({
      router: hybridRouter,
      openHostStackRoute: hybridOpen,
      hostId: 'host/one',
      target: { kind: 'session', hostWorkspaceId: 'repo::/workspace' },
      nativeBaselineEnabled: false
    })
    expect(hybridOpen).not.toHaveBeenCalled()
    expect(hybridRouter.push).toHaveBeenCalledWith('/hybrid?hostId=host%2Fone')
  })

  it('publishes the intent for the hybrid page whichever build routes it', () => {
    navigateFromMobileHome({
      router: { push: vi.fn() },
      openHostStackRoute: vi.fn(),
      hostId: 'host-1',
      target: { kind: 'accounts' },
      source: 'notification',
      nativeBaselineEnabled: true
    })

    expect(latestIntent).toMatchObject({
      source: 'notification',
      hostId: 'host-1',
      target: { kind: 'accounts' }
    })
  })
})

afterAll(() => unsubscribe())
