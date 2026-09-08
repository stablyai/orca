import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  getNotificationNavigationTarget,
  notificationCredentialRecoveryRoute
} from './notification-routing'
import {
  hostStackHostRoute,
  navigateToHostStackRoute,
  type HostStackNavigationState
} from '../navigation/host-stack-navigation'
import {
  mobileWebIntentTargetForNotification,
  MOBILE_WEB_NAVIGATION_INTENTS
} from '../mobile-web/mobile-web-navigation-intent-buffer'
import {
  mobileHomeHostStackTarget,
  navigateFromMobileHome
} from '../mobile-web/mobile-web-home-navigation'

const rootLayoutSource = readFileSync(new URL('../../app/_layout.tsx', import.meta.url), 'utf8')

function navigationHarness(initialState: HostStackNavigationState | undefined) {
  const stateListeners = new Set<() => void>()
  let state = initialState
  const navigation = {
    addListener: vi.fn((_event: 'state', listener: () => void) => {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    }),
    dispatch: vi.fn(),
    getState: () => state
  }
  return {
    navigation,
    setState(nextState: HostStackNavigationState | undefined) {
      state = nextState
      for (const listener of stateListeners) {
        listener()
      }
    }
  }
}

// A notification tap is handled by app/_layout.tsx, which Expo Router mounts as a screen of its
// own internal navigator — hence the extra `__root` level around the app's root stack.
function rootLayoutScopedState(inner: HostStackNavigationState): HostStackNavigationState {
  return { key: 'internal', index: 0, routes: [{ key: '__root', name: '__root', state: inner }] }
}

describe('notification route coordination', () => {
  it('keeps host-only and workspace notification intents distinct', () => {
    expect(getNotificationNavigationTarget({ hostId: 'host-1' })).toEqual({
      kind: 'host',
      hostId: 'host-1'
    })
    expect(
      getNotificationNavigationTarget({ hostId: 'host-1', worktreeId: 'repo::/tmp/worktree' })
    ).toEqual({
      kind: 'session',
      hostId: 'host-1',
      hostWorkspaceId: 'repo::/tmp/worktree'
    })
  })

  it('routes unavailable notification hosts through native recovery', () => {
    expect(
      notificationCredentialRecoveryRoute(
        getNotificationNavigationTarget(
          { hostId: 'host-1' },
          {
            credentialStatusByHostId: new Map([['host-1', 'temporarily-unavailable']])
          }
        )!
      )
    ).toBe('/')
    expect(
      notificationCredentialRecoveryRoute(
        getNotificationNavigationTarget(
          { hostId: 'host-1' },
          { credentialStatusByHostId: new Map([['host-1', 'missing']]) }
        )!
      )
    ).toBe('/pair-scan')
  })

  it('mounts the host before replacing it with the notification session, from a cold navigator', () => {
    const target = getNotificationNavigationTarget({
      hostId: 'host/one',
      worktreeId: 'repo::/Users/me/orca/workspaces/feature'
    })!
    const sessionTarget = mobileHomeHostStackTarget(
      target.hostId,
      mobileWebIntentTargetForNotification(target)
    )!
    // Cold start: the tap is handled before the root navigator has committed any state.
    const harness = navigationHarness(undefined)
    const push = vi.fn()

    navigateToHostStackRoute(
      harness.navigation,
      { push, replace: vi.fn() },
      target.hostId,
      sessionTarget
    )

    expect(push).toHaveBeenCalledWith(hostStackHostRoute('host/one'))
    expect(harness.navigation.dispatch).not.toHaveBeenCalled()

    harness.setState(rootLayoutScopedState({ index: 0, routes: [{ name: 'index' }] }))
    harness.setState(
      rootLayoutScopedState({
        index: 1,
        routes: [{ name: 'index' }, { name: 'h', state: undefined }]
      })
    )
    expect(harness.navigation.dispatch).not.toHaveBeenCalled()

    harness.setState(
      rootLayoutScopedState({
        index: 1,
        routes: [
          { name: 'index' },
          {
            name: 'h',
            state: {
              key: '/h',
              index: 0,
              routes: [
                {
                  key: 'host-index',
                  name: '[hostId]/index',
                  params: { hostId: encodeURIComponent('host/one') }
                }
              ]
            }
          }
        ]
      })
    )

    expect(harness.navigation.dispatch).toHaveBeenCalledWith({
      type: 'REPLACE',
      target: '/h',
      source: 'host-index',
      payload: sessionTarget
    })
  })

  it('leaves a host-only notification as a shallow push with nothing to coordinate', () => {
    const target = getNotificationNavigationTarget({ hostId: 'host-1' })!
    expect(
      mobileHomeHostStackTarget(target.hostId, mobileWebIntentTargetForNotification(target))
    ).toBeNull()
  })

  it('routes a native notification tap through the coordinator, not a bare push', () => {
    const target = getNotificationNavigationTarget({
      hostId: 'host-1',
      worktreeId: 'repo::/tmp/worktree'
    })!
    const router = { push: vi.fn() }
    const openHostStackRoute = vi.fn()

    navigateFromMobileHome({
      router,
      openHostStackRoute,
      hostId: target.hostId,
      target: mobileWebIntentTargetForNotification(target),
      source: 'notification',
      nativeBaselineEnabled: true
    })

    expect(router.push).not.toHaveBeenCalled()
    expect(openHostStackRoute).toHaveBeenCalledWith('host-1', {
      name: '[hostId]/session/[worktreeId]',
      params: { hostId: 'host-1', worktreeId: 'repo::/tmp/worktree' }
    })
    // The hybrid page still gets its intent even though the native stack did the navigating.
    expect(MOBILE_WEB_NAVIGATION_INTENTS.isCurrent(0)).toBe(true)
  })

  it('publishes the validated intent before entering the hybrid route', () => {
    const start = rootLayoutSource.indexOf('// ─── Notification tap routing ───')
    const end = rootLayoutSource.indexOf('// ─── End notification tap routing ───', start)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)

    const notificationEffect = rootLayoutSource.slice(start, end)
    // Already on the hybrid page: publishing the intent *is* the navigation.
    expect(notificationEffect).toContain('MOBILE_WEB_NAVIGATION_INTENTS.publish(navigation.target)')
    expect(notificationEffect).toContain(
      'openMobileHostTarget(\n          navigation.target.hostId,\n          mobileWebIntentTargetForNotification(navigation.target),\n'
    )
    // A bare push into the nested host route lands on a blank host screen (#12001).
    expect(notificationEffect).not.toContain('mobileHomeDestination(')
  })

  it('validates the tap against the full host catalog, not just token-backed hosts', () => {
    const start = rootLayoutSource.indexOf('// ─── Notification tap routing ───')
    const end = rootLayoutSource.indexOf('// ─── End notification tap routing ───', start)
    const notificationEffect = rootLayoutSource.slice(start, end)

    // loadHosts() omits any host whose keychain read failed, which both kills the tap
    // (unknown host id) and hides the credential-recovery status.
    expect(notificationEffect).toContain('resolve(data, loadHostCatalog)')
    expect(notificationEffect).not.toContain('resolve(data, loadHosts)')
  })
})
