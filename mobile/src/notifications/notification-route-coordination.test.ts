import { describe, expect, it, vi } from 'vitest'
import { getNotificationNavigationTarget } from './notification-routing'
import {
  hostStackHostRoute,
  navigateToHostStackRoute,
  type HostStackNavigationState
} from '../navigation/host-stack-navigation'

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

// Include Expo’s internal __root navigator because app/_layout handles taps one level below it.
function rootLayoutScopedState(inner: HostStackNavigationState): HostStackNavigationState {
  return { key: 'internal', index: 0, routes: [{ key: '__root', name: '__root', state: inner }] }
}

describe('notification route coordination', () => {
  it('mounts the host before replacing it with the notification session, from a cold navigator', () => {
    const target = getNotificationNavigationTarget({
      hostId: 'host/one',
      worktreeId: 'repo::/Users/me/orca/workspaces/feature'
    })
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

  it('returns no session target for a host-only notification', () => {
    expect(getNotificationNavigationTarget({ hostId: 'host-1' })?.sessionTarget).toBeNull()
  })
})

it('reuses the current workspace screen and targets the notification pane without pushing', () => {
  const target = getNotificationNavigationTarget({
    hostId: 'host',
    worktreeId: 'folder::/workspace',
    paneKey: 'agent-tab:leaf'
  })!
  const harness = navigationHarness(
    rootLayoutScopedState({
      index: 1,
      routes: [
        { name: 'index' },
        {
          name: 'h',
          state: {
            key: 'host-stack',
            index: 0,
            routes: [
              {
                key: 'existing-workspace',
                name: target.sessionTarget!.name,
                params: { hostId: 'host', worktreeId: 'folder::/workspace' }
              }
            ]
          }
        }
      ]
    })
  )
  const router = { push: vi.fn(), replace: vi.fn() }
  const controller = navigateToHostStackRoute(
    harness.navigation,
    router,
    target.hostId,
    target.sessionTarget!
  )
  expect(router.push).not.toHaveBeenCalled()
  expect(router.replace).not.toHaveBeenCalled()
  expect(harness.navigation.dispatch).toHaveBeenCalledExactlyOnceWith({
    type: 'SET_PARAMS',
    target: 'host-stack',
    source: 'existing-workspace',
    payload: { params: target.sessionTarget!.params }
  })
  expect(controller.isActive()).toBe(false)
})

it('does not reuse a different workspace on the same host', () => {
  const target = getNotificationNavigationTarget({ hostId: 'host', worktreeId: 'workspace-b' })!
  const harness = navigationHarness(
    rootLayoutScopedState({
      index: 0,
      routes: [
        {
          name: 'h',
          state: {
            key: 'host-stack',
            index: 0,
            routes: [
              {
                key: 'workspace-a',
                name: target.sessionTarget!.name,
                params: { hostId: 'host', worktreeId: 'workspace-a' }
              }
            ]
          }
        }
      ]
    })
  )
  const router = { push: vi.fn(), replace: vi.fn() }
  navigateToHostStackRoute(harness.navigation, router, target.hostId, target.sessionTarget!)
  expect(router.push).toHaveBeenCalledOnce()
  expect(harness.navigation.dispatch).not.toHaveBeenCalled()
})
