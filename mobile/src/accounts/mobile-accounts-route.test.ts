import { describe, expect, it, vi } from 'vitest'
import { mobileAccountsRouteTarget } from './mobile-accounts-route'
import {
  hostStackHostRoute,
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

describe('mobile accounts route', () => {
  it('keeps the host id raw for the navigator to encode', () => {
    expect(mobileAccountsRouteTarget('host/one')).toEqual({
      name: '[hostId]/accounts',
      params: { hostId: 'host/one' }
    })
  })

  it('mounts the host before replacing it with the accounts route', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })
    const push = vi.fn()

    navigateToHostStackRoute(
      harness.navigation,
      { push, replace: vi.fn() },
      'host/one',
      mobileAccountsRouteTarget('host/one')
    )

    expect(push).toHaveBeenCalledWith(hostStackHostRoute('host/one'))
    expect(harness.navigation.dispatch).not.toHaveBeenCalled()

    harness.setState({
      index: 1,
      routes: [
        { name: 'index' },
        {
          name: 'h',
          state: {
            key: '/h',
            index: 0,
            routes: [
              {
                key: 'host-index',
                name: '[hostId]/index',
                params: { hostId: encodeURIComponent('host/one') }
              }
            ]
          }
        }
      ]
    })

    expect(harness.navigation.dispatch).toHaveBeenCalledWith({
      type: 'REPLACE',
      target: '/h',
      source: 'host-index',
      payload: mobileAccountsRouteTarget('host/one')
    })
  })
})
