import { describe, expect, it, vi } from 'vitest'
import {
  coordinateHostStackNavigation,
  hostStackHostRoute,
  navigateToHostStackRoute,
  type HostStackNavigationState
} from './host-stack-navigation'

const TARGET = { name: '[hostId]/tasks', params: { hostId: 'host/one' } } as const
const OTHER_TARGET = {
  name: '[hostId]/session/[worktreeId]',
  params: { hostId: 'host/one', worktreeId: 'repo::/tmp/wt' }
} as const

// Removal is modeled for real: a no-op unsubscribe would let `setState` keep
// calling a canceled listener, testing the `active` guard instead of teardown.
function navigationHarness(initialState: HostStackNavigationState) {
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
    setState(nextState: HostStackNavigationState) {
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
  it('matches a host committed as the encoded segment it was pushed as', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })
    const push = vi.fn()

    navigateToHostStackRoute(harness.navigation, { push }, 'host/one', TARGET)
    expect(push).toHaveBeenCalledWith(hostStackHostRoute('host/one'))
    expect(harness.navigation.dispatch).not.toHaveBeenCalled()

    harness.setState(committedHostState(encodeURIComponent('host/one')))

    expect(harness.navigation.dispatch).toHaveBeenCalledTimes(1)
    expect(harness.navigation.dispatch).toHaveBeenCalledWith({
      type: 'REPLACE',
      target: '/h',
      source: 'host-index',
      payload: TARGET
    })
  })

  it('ignores a different host whose id merely decodes badly', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })

    navigateToHostStackRoute(harness.navigation, { push: vi.fn() }, 'host/one', TARGET)
    harness.setState(committedHostState('100%'))

    expect(harness.navigation.dispatch).not.toHaveBeenCalled()
  })

  it('stops listening and never replaces once canceled', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })

    const controller = navigateToHostStackRoute(
      harness.navigation,
      { push: vi.fn() },
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
    const router = { push }

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
    expect(harness.navigation.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ payload: OTHER_TARGET })
    )
  })
})
