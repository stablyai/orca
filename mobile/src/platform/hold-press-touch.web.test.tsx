// @vitest-environment happy-dom
/**
 * The page's hold-press guard. Traced on Pixel_API_37: a held mic got `selectionchange` and then
 * `touchcancel` from the WebView's long-press, each of which ends react-native-web's press.
 */
import { createElement, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { holdTouchesOn, useHoldPressTouchRef } from './hold-press-touch.web'

function touchStartCancelled(target: Element): boolean {
  const event = new Event('touchstart', { bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event.defaultPrevented
}

function Held({ active }: { active: boolean }): ReactElement {
  return createElement('div', { ref: useHoldPressTouchRef(active) })
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('holdTouchesOn', () => {
  it('cancels touchstart on the element and its children only, until released', () => {
    const mic = document.createElement('div')
    const icon = document.createElement('span')
    mic.appendChild(icon)
    const neighbour = document.createElement('div')
    document.body.append(mic, neighbour)

    const release = holdTouchesOn(mic)
    expect(touchStartCancelled(icon)).toBe(true)
    expect(touchStartCancelled(neighbour)).toBe(false)

    release()
    expect(touchStartCancelled(icon)).toBe(false)
  })
})

describe('useHoldPressTouchRef', () => {
  const mic = document.createElement('div')
  const mount = (active: boolean) => {
    const held: { renderer: ReactTestRenderer | null } = { renderer: null }
    act(() => {
      held.renderer = create(createElement(Held, { active }), { createNodeMock: () => mic })
    })
    if (held.renderer === null) {
      throw new Error('nothing mounted')
    }
    return held.renderer
  }

  it('arms and disarms as the mode flips, without a remount', () => {
    const renderer = mount(false)
    expect(touchStartCancelled(mic)).toBe(false)

    act(() => renderer.update(createElement(Held, { active: true })))
    expect(touchStartCancelled(mic)).toBe(true)

    act(() => renderer.update(createElement(Held, { active: false })))
    expect(touchStartCancelled(mic)).toBe(false)
  })

  it('removes the listener when the element unmounts', () => {
    const renderer = mount(true)
    expect(touchStartCancelled(mic)).toBe(true)

    act(() => renderer.unmount())
    expect(touchStartCancelled(mic)).toBe(false)
  })
})
