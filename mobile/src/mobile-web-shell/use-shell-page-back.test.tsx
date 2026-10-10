import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => {
  // Annotated rather than asserted: the literal alone narrows to 'android' and the cases reassign it.
  const platform: { os: 'ios' | 'android' } = { os: 'android' }
  const remove = vi.fn()
  return {
    platform,
    remove,
    addEventListener: vi.fn((_event: string, _handler: () => boolean) => ({ remove }))
  }
})

vi.mock('react-native', () => ({
  BackHandler: {
    addEventListener: (event: string, handler: () => boolean) =>
      native.addEventListener(event, handler)
  },
  get Platform() {
    return { OS: native.platform.os }
  }
}))

import { useShellPageBack } from './use-shell-page-back'

function Screen(props: {
  claimed: boolean
  sendBack: () => boolean
  setOptions: (options: { gestureEnabled: boolean }) => void
}): null {
  useShellPageBack(props)
  return null
}

function render(props: {
  claimed: boolean
  sendBack: () => boolean
  setOptions: (options: { gestureEnabled: boolean }) => void
}): ReactTestRenderer {
  let tree!: ReactTestRenderer
  act(() => {
    tree = create(createElement(Screen, props))
  })
  return tree
}

beforeEach(() => {
  native.platform.os = 'android'
  native.addEventListener.mockClear()
  native.remove.mockClear()
})

/**
 * The shell's half of the key. Nothing is registered without a live claim, so a page too old to
 * make one, a faulted page and a session between documents all keep today's behaviour: the
 * navigator pops.
 */
describe('the shell taking the device Back key for a page that claimed it', () => {
  it('registers nothing while the page holds nothing', () => {
    render({ claimed: false, sendBack: () => true, setOptions: vi.fn() })
    expect(native.addEventListener).not.toHaveBeenCalled()
  })

  it('intercepts the hardware key on Android while the claim is live', () => {
    const sendBack = vi.fn(() => true)
    render({ claimed: true, sendBack, setOptions: vi.fn() })
    expect(native.addEventListener).toHaveBeenCalledTimes(1)
    expect(native.addEventListener.mock.calls[0]?.[0]).toBe('hardwareBackPress')
    expect(native.addEventListener.mock.calls[0]?.[1]?.()).toBe(true)
    expect(sendBack).toHaveBeenCalledTimes(1)
  })

  /**
   * The honest half: a press the host could not deliver — a page too old to take one, a view
   * between documents — falls through to the navigator rather than being swallowed. A key that
   * does nothing is the failure this whole lane exists to remove.
   */
  it('lets a press it could not deliver fall through to the navigator', () => {
    render({ claimed: true, sendBack: () => false, setOptions: vi.fn() })
    expect(native.addEventListener.mock.calls[0]?.[1]?.()).toBe(false)
  })

  it('gives the key back when the claim drops', () => {
    const tree = render({ claimed: true, sendBack: () => true, setOptions: vi.fn() })
    expect(native.remove).not.toHaveBeenCalled()
    act(() => {
      tree.update(
        createElement(Screen, { claimed: false, sendBack: () => true, setOptions: vi.fn() })
      )
    })
    expect(native.remove).toHaveBeenCalledTimes(1)
  })

  it('registers once across a rebuilt sender, so the page beneath does not churn it', () => {
    const tree = render({ claimed: true, sendBack: () => true, setOptions: vi.fn() })
    act(() => {
      tree.update(
        createElement(Screen, { claimed: true, sendBack: () => true, setOptions: vi.fn() })
      )
    })
    expect(native.addEventListener).toHaveBeenCalledTimes(1)
    expect(native.remove).not.toHaveBeenCalled()
  })

  it('reaches for no hardware key on iOS, which has none', () => {
    native.platform.os = 'ios'
    render({ claimed: true, sendBack: () => true, setOptions: vi.fn() })
    expect(native.addEventListener).not.toHaveBeenCalled()
  })

  /** iOS has no key to intercept, so what is taken away is the swipe: a swipe-back over an open
   *  sheet would leave the screen with the sheet still on it. */
  it('takes the stack swipe away on iOS while the claim is live, and restores it after', () => {
    native.platform.os = 'ios'
    const setOptions = vi.fn()
    const tree = render({ claimed: true, sendBack: () => true, setOptions })
    expect(setOptions).toHaveBeenCalledWith({ gestureEnabled: false })
    act(() => {
      tree.update(createElement(Screen, { claimed: false, sendBack: () => true, setOptions }))
    })
    expect(setOptions).toHaveBeenLastCalledWith({ gestureEnabled: true })
  })

  it('writes no gesture option on Android, where the stack has no swipe to take', () => {
    const setOptions = vi.fn()
    render({ claimed: true, sendBack: () => true, setOptions })
    expect(setOptions).not.toHaveBeenCalled()
  })
})
