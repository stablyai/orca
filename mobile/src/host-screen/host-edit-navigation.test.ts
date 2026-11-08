import { describe, expect, it, vi } from 'vitest'
import {
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

// Replacement targets the nested host stack, so committed fixtures must include it.
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
  it('does not replace an unrelated host route', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })

    navigateToMobileHostEdit(harness.navigation, { push: vi.fn(), replace: vi.fn() }, 'host-1')
    harness.setState(committedHostState('host-2'))

    expect(harness.navigation.dispatch).not.toHaveBeenCalled()
  })
})
