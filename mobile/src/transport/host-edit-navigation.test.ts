import { describe, expect, it, vi } from 'vitest'
import {
  mobileHostEditHostRoute,
  mobileHostEditRoute,
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

describe('mobile host edit navigation', () => {
  it('waits for the expected host route to commit before replacing it with Edit', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })
    const push = vi.fn()
    const replace = vi.fn()

    navigateToMobileHostEdit(harness.navigation, { push, replace }, 'host/1')

    expect(push).toHaveBeenCalledWith(mobileHostEditHostRoute('host/1'))
    expect(replace).not.toHaveBeenCalled()

    harness.setState({
      index: 1,
      routes: [{ name: 'index' }, { name: 'h', params: { hostId: 'host/1' } }]
    })

    expect(harness.unsubscribeState).toHaveBeenCalledOnce()
    expect(replace).toHaveBeenCalledWith(mobileHostEditRoute('host/1'))
  })

  it('does not replace an unrelated host route', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })
    const replace = vi.fn()

    navigateToMobileHostEdit(harness.navigation, { push: vi.fn(), replace }, 'host-1')
    harness.setState({ index: 0, routes: [{ name: 'h', params: { hostId: 'host-2' } }] })

    expect(replace).not.toHaveBeenCalled()
  })

  it('cancels a pending replacement when navigation leaves the host flow', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })
    const replace = vi.fn()
    const controller = navigateToMobileHostEdit(
      harness.navigation,
      { push: vi.fn(), replace },
      'host-1'
    )

    harness.setState({ index: 0, routes: [{ name: 'h', params: { hostId: 'host-2' } }] })
    controller.cancel()
    harness.setState({ index: 0, routes: [{ name: 'h', params: { hostId: 'host-1' } }] })

    expect(harness.unsubscribeState).toHaveBeenCalledOnce()
    expect(replace).not.toHaveBeenCalled()
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
          },
          replace: vi.fn()
        },
        'host-1'
      )
    ).toThrow(error)
    expect(harness.unsubscribeState).toHaveBeenCalledOnce()
  })
})
