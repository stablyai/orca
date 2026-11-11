import { describe, expect, it, vi } from 'vitest'
import {
  coordinateHostStackNavigation,
  navigateToHostStackRoute,
  type HostStackNavigationState
} from './host-stack-navigation'

const TARGET = { name: '[hostId]/tasks', params: { hostId: 'host/one' } } as const
const OTHER_TARGET = {
  name: '[hostId]/session/[worktreeId]',
  params: { hostId: 'host/one', worktreeId: 'repo::/tmp/wt' }
} as const

// Remove listeners for real so teardown is tested instead of merely the active guard.
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
  it('stops listening and never replaces once canceled', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })

    const controller = navigateToHostStackRoute(
      harness.navigation,
      { push: vi.fn(), replace: vi.fn() },
      'host/one',
      TARGET
    )
    expect(harness.listenerCount()).toBe(1)
    controller.cancel()

    expect(harness.unsubscribe).toHaveBeenCalledTimes(1)
    expect(harness.listenerCount()).toBe(0)
    expect(controller.isActive()).toBe(false)

    harness.setState(committedHostState('host/one'))
    expect(harness.navigation.dispatch).not.toHaveBeenCalled()
  })

  it('retargets a still-pending transition to the same host instead of pushing twice', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })
    const push = vi.fn()
    const router = { push, replace: vi.fn() }

    const pending = coordinateHostStackNavigation(
      null,
      harness.navigation,
      router,
      'host/one',
      TARGET
    )
    const retargeted = coordinateHostStackNavigation(
      pending,
      harness.navigation,
      router,
      'host/one',
      OTHER_TARGET
    )

    expect(retargeted).toBe(pending)
    expect(push).toHaveBeenCalledTimes(1)
    expect(harness.listenerCount()).toBe(1)

    harness.setState(committedHostState('host/one'))

    expect(harness.navigation.dispatch).toHaveBeenCalledTimes(1)
    expect(harness.navigation.dispatch).toHaveBeenCalledWith({
      type: 'REPLACE',
      target: '/h',
      source: 'host-index',
      payload: OTHER_TARGET
    })
  })

  it('replaces the host list when opening a session directly from Home and pushes when already inside that host', () => {
    const fromHome = navigationHarness({ index: 0, routes: [{ name: 'index' }] })
    const push = vi.fn()
    navigateToHostStackRoute(
      fromHome.navigation,
      { push, replace: vi.fn() },
      'host/one',
      OTHER_TARGET
    )
    fromHome.setState(committedHostState('host/one'))

    expect(push).toHaveBeenCalledWith('/h/host%2Fone')
    expect(fromHome.navigation.dispatch.mock.calls).toEqual([
      [{ type: 'REPLACE', target: '/h', source: 'host-index', payload: OTHER_TARGET }]
    ])

    const inHost = navigationHarness(committedHostState('host/one'))
    const inHostPush = vi.fn()
    navigateToHostStackRoute(
      inHost.navigation,
      { push: inHostPush, replace: vi.fn() },
      'host/one',
      OTHER_TARGET
    )

    expect(inHostPush).not.toHaveBeenCalled()
    expect(inHost.navigation.dispatch.mock.calls).toEqual([
      [{ type: 'PUSH', target: '/h', payload: OTHER_TARGET }]
    ])
  })

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

    it('lets another screen tapped while the push commits take the list place', () => {
      const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })
      const push = vi.fn()
      const router = { push, replace: vi.fn() }

      const pending = coordinateHostStackNavigation(
        null,
        harness.navigation,
        router,
        'host/one',
        SESSION,
        true
      )
      coordinateHostStackNavigation(pending, harness.navigation, router, 'host/one', TARGET)
      harness.setState(committedHostState('host/one'))

      expect(push).toHaveBeenCalledTimes(1)
      expect(harness.navigation.dispatch.mock.calls).toEqual([
        [{ type: 'REPLACE', target: '/h', source: 'host-index', payload: TARGET }]
      ])
    })
  })
})
