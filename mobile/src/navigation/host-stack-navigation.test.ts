import { describe, expect, it, vi } from 'vitest'
import {
  coordinateHostStackNavigation,
  type HostStackNavigationState
} from './host-stack-navigation'

function navigationHarness(initialState: HostStackNavigationState | undefined) {
  const stateListeners = new Set<() => void>()
  let state = initialState
  const unsubscribe = vi.fn()
  const navigation = {
    addListener: vi.fn((_event: 'state', listener: () => void) => {
      stateListeners.add(listener)
      return () => {
        unsubscribe()
        stateListeners.delete(listener)
      }
    }),
    dispatch: vi.fn(),
    getState: () => state
  }
  return {
    navigation,
    unsubscribe,
    listenerCount: () => stateListeners.size,
    setState(nextState: HostStackNavigationState | undefined) {
      state = nextState
      for (const listener of stateListeners) {
        listener()
      }
    }
  }
}

function committedHostState(hostIdParam: string): HostStackNavigationState {
  return {
    index: 0,
    routes: [
      {
        name: 'h',
        state: {
          key: '/h',
          index: 0,
          routes: [{ key: 'host-index', name: '[hostId]/index', params: { hostId: hostIdParam } }]
        }
      }
    ]
  }
}

describe('host stack navigation', () => {
  describe('a session opened inside its host document', () => {
    const SESSION = {
      name: '[hostId]/session/[worktreeId]',
      params: { hostId: 'host/one', worktreeId: 'repo::/tmp/wt', paneKey: 'tab-1:leaf 2' }
    } as const
    it('opens a different session tapped while the push commits on the host stack it mounts', () => {
      const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })
      const push = vi.fn()
      const router = { push, replace: vi.fn() }
      const OTHER_SESSION = {
        name: '[hostId]/session/[worktreeId]',
        params: { hostId: 'host/one', worktreeId: 'repo::/tmp/other' }
      } as const

      const pending = coordinateHostStackNavigation(
        null,
        harness.navigation,
        router,
        'host/one',
        SESSION,
        true
      )
      coordinateHostStackNavigation(
        pending,
        harness.navigation,
        router,
        'host/one',
        OTHER_SESSION,
        true
      )
      harness.setState(committedHostState('host/one'))

      expect(push).toHaveBeenCalledTimes(1)
      expect(harness.navigation.dispatch.mock.calls).toEqual([
        [
          {
            type: 'SET_PARAMS',
            target: '/h',
            source: 'host-index',
            payload: {
              params: { open: '%2Fh%2Fhost%252Fone%2Fsession%2Frepo%253A%253A%252Ftmp%252Fother' }
            }
          }
        ]
      ])
    })
  })
})
