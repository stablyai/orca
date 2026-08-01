import { describe, expect, it, vi } from 'vitest'
import {
  hostStackHostRoute,
  navigateToHostStackRoute,
  type HostStackNavigationState
} from './host-stack-navigation'

const TARGET = { name: '[hostId]/tasks', params: { hostId: 'host/one' } } as const

function navigationHarness(initialState: HostStackNavigationState) {
  let stateListener = () => {}
  let state = initialState
  const navigation = {
    addListener: vi.fn((_event: 'state', listener: () => void) => {
      stateListener = listener
      return vi.fn()
    }),
    dispatch: vi.fn(),
    getState: () => state
  }
  return {
    navigation,
    setState(nextState: HostStackNavigationState) {
      state = nextState
      stateListener()
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

    harness.setState(committedHostState(encodeURIComponent('host/one')))

    expect(harness.navigation.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'host-index', payload: TARGET })
    )
  })

  it('ignores a different host whose id merely decodes badly', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })

    navigateToHostStackRoute(harness.navigation, { push: vi.fn() }, 'host/one', TARGET)
    harness.setState(committedHostState('100%'))

    expect(harness.navigation.dispatch).not.toHaveBeenCalled()
  })
})
