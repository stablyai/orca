import { describe, expect, it, vi } from 'vitest'
import {
  coordinateHostStackNavigation,
  navigateToHostStackRoute,
  sessionHostStackLevel,
  withHostSessionListBeneath,
  type HostStackNavigationRoute,
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

// Model Expo’s internal root navigator: the host stack sits one level below the layout screen.
function rootLayoutScopedState(inner: HostStackNavigationState): HostStackNavigationState {
  return { key: 'internal', index: 0, routes: [{ key: '__root', name: '__root', state: inner }] }
}

describe('host stack navigation', () => {
  it('matches a host committed as the encoded segment it was pushed as', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })
    const push = vi.fn()

    navigateToHostStackRoute(harness.navigation, { push, replace: vi.fn() }, 'host/one', TARGET)
    expect(push).toHaveBeenCalledWith('/h/host%2Fone')
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
    expect(replace).toHaveBeenCalledWith({
      pathname: '/h/[hostId]/tasks',
      params: { hostId: 'host/one' }
    })
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
    expect(harness.navigation.dispatch).toHaveBeenCalledWith({
      type: 'PUSH',
      target: '/h',
      payload: OTHER_TARGET
    })
  })

  it('pushes a session onto a host list that is already mounted, without pushing that host again', () => {
    const harness = navigationHarness(committedHostState('host/one'))
    const push = vi.fn()

    const controller = navigateToHostStackRoute(
      harness.navigation,
      { push, replace: vi.fn() },
      'host/one',
      OTHER_TARGET
    )

    expect(push).not.toHaveBeenCalled()
    expect(harness.navigation.dispatch).toHaveBeenCalledWith({
      type: 'PUSH',
      target: '/h',
      payload: OTHER_TARGET
    })
    expect(controller.isActive()).toBe(false)
    expect(harness.listenerCount()).toBe(0)
  })

  it('still replaces an already mounted host list when the target is not a session', () => {
    const harness = navigationHarness(committedHostState('host/one'))
    const push = vi.fn()
    const replace = vi.fn()

    navigateToHostStackRoute(harness.navigation, { push, replace }, 'host/one', TARGET)

    expect(push).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    expect(harness.navigation.dispatch).toHaveBeenCalledWith({
      type: 'REPLACE',
      target: '/h',
      source: 'host-index',
      payload: TARGET
    })
  })

  it('pushes the session href when the host route has no child stack yet', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })
    const push = vi.fn()
    const replace = vi.fn()

    navigateToHostStackRoute(harness.navigation, { push, replace }, 'host/one', OTHER_TARGET)
    harness.setState({
      index: 0,
      routes: [{ name: 'h', params: { hostId: 'host/one' } }]
    })

    expect(harness.navigation.dispatch).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    expect(push).toHaveBeenNthCalledWith(1, '/h/host%2Fone')
    expect(push).toHaveBeenNthCalledWith(2, {
      pathname: '/h/[hostId]/session/[worktreeId]',
      params: OTHER_TARGET.params
    })
  })
})

const SESSION = '[hostId]/session/[worktreeId]'

function sessionRoute(hostId: string, key = 'session'): HostStackNavigationRoute {
  return { key, name: SESSION, params: { hostId, worktreeId: 'wt' } }
}

describe('host session list beneath a session', () => {
  it('inserts the host list before a session and keeps the screens above it', () => {
    const server = { key: 'server', name: 'index' }
    const session = sessionRoute('host/one')
    const settings = { key: 'settings', name: 'settings' }
    const level = { key: 'host-stack', index: 2, routes: [server, session, settings] }

    expect(withHostSessionListBeneath(level, 'host/one')).toEqual({
      index: 3,
      routes: [
        server,
        {
          key: 'host-session-list:host/one',
          name: '[hostId]/index',
          params: { hostId: 'host/one' }
        },
        session,
        settings
      ]
    })
    expect(sessionHostStackLevel(level, 'host/one')).toBe(level)
  })

  it('reads the host list from the focused host stack rather than the root', () => {
    const session = sessionRoute('host-1')
    const nested = { key: 'nested', index: 0, routes: [session] }
    const root = {
      index: 0,
      routes: [{ name: 'h', state: nested }]
    }

    expect(sessionHostStackLevel(root, 'host-1')).toBe(nested)
  })

  it('does not insert a second host list when that host is already underneath', () => {
    const hostList = {
      key: 'host-index',
      name: '[hostId]/index',
      params: { hostId: 'host%2Fone' }
    }
    const session = sessionRoute('host/one')

    expect(
      withHostSessionListBeneath({ index: 1, routes: [hostList, session] }, 'host/one')
    ).toBeNull()
  })

  it('does not insert a list for a different host, and copies the session host param', () => {
    const session = sessionRoute('host%2Fone', 'encoded-session')
    const other = sessionRoute('host-2', 'other-session')

    expect(withHostSessionListBeneath({ index: 0, routes: [other] }, 'host/one')).toBeNull()
    expect(withHostSessionListBeneath({ index: 0, routes: [session] }, 'host/one')).toEqual({
      index: 1,
      routes: [
        {
          key: 'host-session-list:host/one',
          name: '[hostId]/index',
          params: { hostId: 'host%2Fone' }
        },
        session
      ]
    })
  })
})
