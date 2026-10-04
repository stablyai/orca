// @vitest-environment happy-dom
/**
 * The page's form of `keyboardShouldPersistTaps`, which react-native-web ignores.
 *
 * Measured on Pixel_API_37: a tap on a dock key or a session tab moves focus from the live input
 * to the Pressable (tabindex 0) on mousedown, and the IME closes. Natively a Pressable never takes
 * focus, so the same taps keep the keyboard up.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { keepTextFocusThroughTaps } from './keyboard-persisting-taps.web'

function plant() {
  const container = document.createElement('div')
  const button = document.createElement('div')
  button.tabIndex = 0
  const label = document.createElement('span')
  button.appendChild(label)
  const gap = document.createElement('span')
  const field = document.createElement('input')
  container.append(button, gap, field)
  const liveInput = document.createElement('input')
  document.body.append(container, liveInput)
  return { container, label, gap, field, liveInput }
}

/** Whether a mousedown on `target` was kept from moving focus. */
function pressKeepsFocus(target: Element): boolean {
  const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event.defaultPrevented
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('keepTextFocusThroughTaps', () => {
  it("keeps a text field's focus through a tap on a pressable, in both modes", () => {
    for (const mode of ['always', 'handled'] as const) {
      const { container, label, liveInput } = plant()
      const release = keepTextFocusThroughTaps(container, mode)
      liveInput.focus()
      expect(pressKeepsFocus(label), mode).toBe(true)
      release()
      document.body.innerHTML = ''
    }
  })

  it('lets a tap on nothing pressable dismiss only when taps are handled', () => {
    const always = plant()
    keepTextFocusThroughTaps(always.container, 'always')
    always.liveInput.focus()
    expect(pressKeepsFocus(always.gap)).toBe(true)
    document.body.innerHTML = ''

    const handled = plant()
    keepTextFocusThroughTaps(handled.container, 'handled')
    handled.liveInput.focus()
    expect(pressKeepsFocus(handled.gap)).toBe(false)
  })

  it('leaves focus alone when no text field holds it, or when the tap is on a text field', () => {
    const { container, label, field, liveInput } = plant()
    keepTextFocusThroughTaps(container, 'always')
    expect(pressKeepsFocus(label)).toBe(false)
    liveInput.focus()
    expect(pressKeepsFocus(field)).toBe(false)
  })

  it('does not count a focusable ancestor above the container as a pressable in the bar', () => {
    const outer = document.createElement('div')
    outer.tabIndex = 0
    const { container, gap, liveInput } = plant()
    outer.append(container)
    document.body.prepend(outer)
    keepTextFocusThroughTaps(container, 'handled')
    liveInput.focus()
    expect(pressKeepsFocus(gap)).toBe(false)
  })

  it('stops when released', () => {
    const { container, label, liveInput } = plant()
    keepTextFocusThroughTaps(container, 'always')()
    liveInput.focus()
    expect(pressKeepsFocus(label)).toBe(false)
  })
})
