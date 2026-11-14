import { describe, expect, it, vi } from 'vitest'
import { mobileSessionRouteTarget } from './mobile-session-route'
import {
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
  it('mounts the host, then puts a standalone session in place of its list', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })
    const target = mobileSessionRouteTarget({
      hostId: 'host/one',
      worktreeId: 'repo::/tmp/wt',
      standalone: true
    })

    navigateToHostStackRoute(
      harness.navigation,
      { push: vi.fn(), replace: vi.fn() },
      'host/one',
      target
    )
    harness.setState(mountedHostState('host/one'))

    expect(harness.navigation.dispatch.mock.calls).toEqual([
      [
        {
          type: 'REPLACE',
          target: '/h',
          source: 'host-index',
          payload: {
            name: '[hostId]/session/[worktreeId]',
            params: { hostId: 'host/one', worktreeId: 'repo::/tmp/wt', standalone: '1' }
          }
        }
      ]
    ])
  })
})
