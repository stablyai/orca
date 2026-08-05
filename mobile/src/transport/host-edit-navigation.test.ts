import { describe, expect, it, vi } from 'vitest'
import {
  mobileHostEditHostRoute,
  mobileHostEditRouteTarget,
  navigateToMobileHostEdit,
  type MobileHostEditNavigationState
} from './host-edit-navigation'

function navigationHarness(initialState: MobileHostEditNavigationState) {
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
    setState(nextState: MobileHostEditNavigationState) {
      state = nextState
      stateListener()
    },
    unsubscribeState
  }
}

// Edit now waits for the nested host stack, not just the root `h` route, so every committed
// state below carries the stack the replacement targets.
function committedHostState(hostIdParam: string): MobileHostEditNavigationState {
  return {
    index: 1,
    routes: [
      { name: 'index' },
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

describe('mobile host edit navigation', () => {
  it('waits for the expected host stack to commit before replacing it with Edit', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })
    const push = vi.fn()

    navigateToMobileHostEdit(harness.navigation, { push }, 'host/1')

    expect(push).toHaveBeenCalledWith(mobileHostEditHostRoute('host/1'))
    expect(harness.navigation.dispatch).not.toHaveBeenCalled()

    // The host route commits before its stack mounts; the old root-only predicate fired here.
    harness.setState({ index: 1, routes: [{ name: 'index' }, { name: 'h' }] })
    expect(harness.navigation.dispatch).not.toHaveBeenCalled()

    harness.setState(committedHostState('host%2F1'))

    expect(harness.unsubscribeState).toHaveBeenCalledOnce()
    expect(harness.navigation.dispatch).toHaveBeenCalledWith({
      type: 'REPLACE',
      target: '/h',
      source: 'host-index',
      payload: mobileHostEditRouteTarget('host/1')
    })
  })

  it('does not replace an unrelated host route', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })

    navigateToMobileHostEdit(harness.navigation, { push: vi.fn() }, 'host-1')
    harness.setState(committedHostState('host-2'))

    expect(harness.navigation.dispatch).not.toHaveBeenCalled()
  })

  it('disposes itself when navigation leaves the host flow without cancel()', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })
    navigateToMobileHostEdit(harness.navigation, { push: vi.fn() }, 'host-1')

    // Enter the host flow for a different host, then leave it entirely.
    harness.setState(committedHostState('host-2'))
    harness.setState({ index: 0, routes: [{ name: 'index' }] })
    expect(harness.unsubscribeState).toHaveBeenCalledOnce()

    // A late matching commit must not resurrect the replacement.
    harness.setState(committedHostState('host-1'))
    expect(harness.navigation.dispatch).not.toHaveBeenCalled()
  })

  it('cancels a pending replacement when navigation leaves the host flow', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })
    const controller = navigateToMobileHostEdit(harness.navigation, { push: vi.fn() }, 'host-1')

    harness.setState(committedHostState('host-2'))
    controller.cancel()
    harness.setState(committedHostState('host-1'))

    expect(harness.unsubscribeState).toHaveBeenCalledOnce()
    expect(harness.navigation.dispatch).not.toHaveBeenCalled()
  })

  it('unsubscribes when mounting the host throws synchronously', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })
    const error = new Error('navigation failed')

    expect(() =>
      navigateToMobileHostEdit(
        harness.navigation,
        {
          push: () => {
            throw error
          }
        },
        'host-1'
      )
    ).toThrow(error)
    expect(harness.unsubscribeState).toHaveBeenCalledOnce()
  })
})
