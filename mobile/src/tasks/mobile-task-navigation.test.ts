import { describe, expect, it, vi } from 'vitest'
import {
  coordinateMobileTasksNavigation,
  mobileTasksHostRoute,
  navigateToMobileTasks,
  type MobileTasksNavigationState
} from './mobile-task-navigation'

function navigationHarness(initialState: MobileTasksNavigationState) {
  let stateListener = () => {}
  let state = initialState
  const unsubscribeState = vi.fn()
  const navigation = {
    addListener: vi.fn((_event: 'state', listener: () => void) => {
      stateListener = listener
      return unsubscribeState
    }),
    dispatch: vi.fn(),
    getState: () => state
  }
  return {
    navigation,
    setState(nextState: MobileTasksNavigationState) {
      state = nextState
      stateListener()
    },
    unsubscribeState
  }
}

describe('mobile task navigation', () => {
  it('waits for the expected host commit before navigating to Tasks', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })
    const push = vi.fn()
    const replace = vi.fn()

    navigateToMobileTasks(harness.navigation, { push, replace }, 'host/1')

    expect(harness.navigation.addListener.mock.invocationCallOrder[0]).toBeLessThan(
      push.mock.invocationCallOrder[0]!
    )
    expect(push).toHaveBeenCalledWith(mobileTasksHostRoute('host/1'))
    expect(harness.navigation.dispatch).not.toHaveBeenCalled()

    harness.setState({
      index: 1,
      routes: [{ name: 'index' }, { name: 'h', params: { hostId: 'host/1' } }]
    })
    expect(harness.navigation.dispatch).not.toHaveBeenCalled()
    expect(harness.unsubscribeState).toHaveBeenCalledOnce()
    expect(harness.unsubscribeState.mock.invocationCallOrder[0]).toBeLessThan(
      replace.mock.invocationCallOrder[0]!
    )
    expect(replace).toHaveBeenCalledWith({
      pathname: '/h/[hostId]/tasks',
      params: { hostId: 'host/1' }
    })
  })

  it('ignores unrelated state events and preserves the provider', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })

    navigateToMobileTasks(
      harness.navigation,
      { push: vi.fn(), replace: vi.fn() },
      'host-1',
      'linear'
    )
    harness.setState({ index: 1, routes: [{ name: 'index' }, { name: 'settings' }] })
    expect(harness.navigation.dispatch).not.toHaveBeenCalled()
    harness.setState({ index: 0, routes: [{ name: 'h', params: { hostId: 'host-2' } }] })
    expect(harness.navigation.dispatch).not.toHaveBeenCalled()
    harness.setState({
      index: 0,
      routes: [
        {
          name: 'h',
          state: {
            key: '/h',
            index: 0,
            routes: [{ key: 'host-index', name: '[hostId]/index', params: { hostId: 'host-1' } }]
          }
        }
      ]
    })

    expect(harness.navigation.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          name: '[hostId]/tasks',
          params: { hostId: 'host-1', taskSource: 'linear' }
        }
      })
    )
  })

  it('cleanup prevents a stale navigation from replacing', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })
    const replace = vi.fn()
    const controller = navigateToMobileTasks(
      harness.navigation,
      { push: vi.fn(), replace },
      'host-1'
    )

    controller.cancel()
    harness.setState({ index: 0, routes: [{ name: 'h', params: { hostId: 'host-1' } }] })

    expect(harness.unsubscribeState).toHaveBeenCalledOnce()
    expect(harness.navigation.dispatch).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it('reuses a pending host push and applies the latest provider', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })
    const push = vi.fn()
    const router = { push, replace: vi.fn() }

    const first = coordinateMobileTasksNavigation(
      null,
      harness.navigation,
      router,
      'host-1',
      'github'
    )
    const second = coordinateMobileTasksNavigation(
      first,
      harness.navigation,
      router,
      'host-1',
      'linear'
    )
    harness.setState({
      index: 0,
      routes: [
        {
          name: 'h',
          state: {
            key: '/h',
            index: 0,
            routes: [{ key: 'host-index', name: '[hostId]/index', params: { hostId: 'host-1' } }]
          }
        }
      ]
    })

    expect(second).toBe(first)
    expect(push).toHaveBeenCalledOnce()
    expect(harness.navigation.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          name: '[hostId]/tasks',
          params: { hostId: 'host-1', taskSource: 'linear' }
        }
      })
    )
  })

  it('keeps waiting through host setup without params and cleans up when navigation leaves', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })
    const replace = vi.fn()

    navigateToMobileTasks(harness.navigation, { push: vi.fn(), replace }, 'host-1')
    harness.setState({ index: 0, routes: [{ name: 'h' }] })
    expect(harness.unsubscribeState).not.toHaveBeenCalled()
    harness.setState({ index: 0, routes: [{ name: 'index' }] })
    harness.setState({
      index: 0,
      routes: [
        {
          name: 'h',
          state: {
            key: '/h',
            index: 0,
            routes: [{ key: 'host-index', name: '[hostId]/index', params: { hostId: 'host-1' } }]
          }
        }
      ]
    })

    expect(harness.unsubscribeState).toHaveBeenCalledOnce()
    expect(harness.navigation.dispatch).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it('unsubscribes when mounting the host throws synchronously', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })
    const error = new Error('navigation failed')

    expect(() =>
      navigateToMobileTasks(
        harness.navigation,
        {
          push: () => {
            throw error
          },
          replace: vi.fn()
        },
        'host-1'
      )
    ).toThrow(error)
    expect(harness.unsubscribeState).toHaveBeenCalledOnce()
  })
})
