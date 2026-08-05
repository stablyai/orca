import { describe, expect, it, vi } from 'vitest'
import {
  coordinateHostStackNavigation,
  hostStackHostRoute,
  hostStackRouteHref,
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

// The shape app/_layout.tsx sees: Expo Router mounts it as a screen of its own internal
// navigator, so every route the host stack lives in sits one level below.
function rootLayoutScopedState(inner: HostStackNavigationState): HostStackNavigationState {
  return { key: 'internal', index: 0, routes: [{ key: '__root', name: '__root', state: inner }] }
}

describe('host stack navigation', () => {
  it('matches a host committed as the encoded segment it was pushed as', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })
    const push = vi.fn()

    navigateToHostStackRoute(harness.navigation, { push, replace: vi.fn() }, 'host/one', TARGET)
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

  it('replaces the host stack seen from the root layout, one navigator further down', () => {
    const harness = navigationHarness(
      rootLayoutScopedState({ index: 0, routes: [{ name: 'index' }] })
    )

    navigateToHostStackRoute(
      harness.navigation,
      { push: vi.fn(), replace: vi.fn() },
      'host/one',
      TARGET
    )
    harness.setState(rootLayoutScopedState(committedHostState('host/one')))

    expect(harness.navigation.dispatch).toHaveBeenCalledWith({
      type: 'REPLACE',
      target: '/h',
      source: 'host-index',
      payload: TARGET
    })
  })

  it('survives the state emitted before the root navigator has hydrated', () => {
    const harness = navigationHarness(undefined)

    navigateToHostStackRoute(
      harness.navigation,
      { push: vi.fn(), replace: vi.fn() },
      'host/one',
      TARGET
    )

    expect(() => harness.setState(undefined)).not.toThrow()
    expect(harness.navigation.dispatch).not.toHaveBeenCalled()

    harness.setState(rootLayoutScopedState(committedHostState('host/one')))
    expect(harness.navigation.dispatch).toHaveBeenCalledTimes(1)
  })

  it('replaces through Expo Router when root state omits the mounted child stack', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })
    const replace = vi.fn()

    navigateToHostStackRoute(harness.navigation, { push: vi.fn(), replace }, 'host/one', TARGET)
    harness.setState({
      index: 0,
      routes: [{ name: 'h', params: { hostId: 'host/one' } }]
    })

    expect(harness.navigation.dispatch).not.toHaveBeenCalled()
    expect(replace).toHaveBeenCalledWith(hostStackRouteHref(TARGET))
    expect(harness.listenerCount()).toBe(0)
  })

  it('abandons the transition when navigation leaves the host route it was waiting on', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })

    navigateToHostStackRoute(
      harness.navigation,
      { push: vi.fn(), replace: vi.fn() },
      'host/one',
      TARGET
    )
    harness.setState({ index: 0, routes: [{ name: 'h' }] })
    harness.setState({ index: 0, routes: [{ name: 'index' }] })
    harness.setState(committedHostState('host/one'))

    expect(harness.navigation.dispatch).not.toHaveBeenCalled()
    expect(harness.listenerCount()).toBe(0)
  })

  it('ignores a different host whose id merely decodes badly', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })

    navigateToHostStackRoute(
      harness.navigation,
      { push: vi.fn(), replace: vi.fn() },
      'host/one',
      TARGET
    )
    harness.setState(committedHostState('100%'))

    expect(harness.navigation.dispatch).not.toHaveBeenCalled()
  })

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
    expect(harness.navigation.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ payload: OTHER_TARGET })
    )
  })
})
