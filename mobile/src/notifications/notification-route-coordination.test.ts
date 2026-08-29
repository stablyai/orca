import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { getNotificationNavigationTarget } from './notification-routing'
import {
  hostStackHostRoute,
  navigateToHostStackRoute,
  type HostStackNavigationState
} from '../navigation/host-stack-navigation'

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
  it('mounts the host before replacing it with the notification session, from a cold navigator', () => {
    const target = getNotificationNavigationTarget({
      hostId: 'host/one',
      worktreeId: 'repo::/Users/me/orca/workspaces/feature'
    })
    // Cold start: the tap is handled before the root navigator has committed any state.
    const harness = navigationHarness(undefined)
    const push = vi.fn()

    navigateToHostStackRoute(
      harness.navigation,
      { push, replace: vi.fn() },
      target!.hostId,
      target!.sessionTarget!
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
      payload: target!.sessionTarget
    })
  })

  it('leaves a host-only notification as a shallow push with nothing to coordinate', () => {
    expect(getNotificationNavigationTarget({ hostId: 'host-1' })?.sessionTarget).toBeNull()
  })

  it('routes notification taps through the coordinated transition, not a bare push', () => {
    const start = rootLayoutSource.indexOf('// ─── Notification tap routing ───')
    const end = rootLayoutSource.indexOf('// ─── End notification tap routing ───', start)

    // Assert the markers first: a renamed banner would otherwise slice garbage and report a
    // missing call instead of the real cause.
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)

    const notificationEffect = rootLayoutSource.slice(start, end)
    expect(notificationEffect).toContain('openNotificationRoute(target)')
    expect(notificationEffect).not.toContain('router.push(')
  })
})
