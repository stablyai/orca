import { describe, expect, it, vi } from 'vitest'
import { mobileSessionRouteTarget } from './mobile-session-route'
import {
  hostStackHostRoute,
  navigateToHostStackRoute,
  type HostStackNavigationState
} from '../navigation/host-stack-navigation'

function navigationHarness(initialState: HostStackNavigationState) {
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
    setState(nextState: HostStackNavigationState) {
      state = nextState
      for (const listener of stateListeners) {
        listener()
      }
    }
  }
}

function mountedHostState(hostId: string): HostStackNavigationState {
  return {
    index: 1,
    routes: [
      { name: 'index' },
      {
        name: 'h',
        state: {
          key: '/h',
          index: 0,
          routes: [{ key: 'host-index', name: '[hostId]/index', params: { hostId } }]
        }
      }
    ]
  }
}

describe('mobile session route', () => {
  it('keeps dynamic route identities raw for the navigator to encode', () => {
    expect(
      mobileSessionRouteTarget({
        hostId: 'host/one',
        worktreeId: 'repo::/Users/ada/orca/workspaces/fix #1',
        name: 'Fix #1'
      })
    ).toEqual({
      name: '[hostId]/session/[worktreeId]',
      params: {
        hostId: 'host/one',
        worktreeId: 'repo::/Users/ada/orca/workspaces/fix #1',
        name: 'Fix #1'
      }
    })
  })

  it('omits an absent workspace name instead of sending an empty param', () => {
    expect(
      mobileSessionRouteTarget({ hostId: 'host-1', worktreeId: 'repo::/tmp/wt' }).params
    ).toEqual({ hostId: 'host-1', worktreeId: 'repo::/tmp/wt' })
  })

  it('mounts the host before replacing it with the session route', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })
    const push = vi.fn()
    const target = mobileSessionRouteTarget({
      hostId: 'host/one',
      worktreeId: 'repo::/Users/ada/orca/workspaces/fix #1',
      name: 'Fix #1'
    })

    navigateToHostStackRoute(harness.navigation, { push, replace: vi.fn() }, 'host/one', target)

    expect(push).toHaveBeenCalledWith(hostStackHostRoute('host/one'))
    expect(harness.navigation.dispatch).not.toHaveBeenCalled()

    harness.setState(mountedHostState('host/one'))

    expect(harness.navigation.dispatch).toHaveBeenCalledWith({
      type: 'REPLACE',
      target: '/h',
      source: 'host-index',
      payload: target
    })
  })
})
