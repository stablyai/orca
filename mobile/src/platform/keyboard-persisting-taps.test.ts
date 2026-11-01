// @vitest-environment happy-dom
// RN Web ignores keyboardShouldPersistTaps; focusable Pressables take mousedown focus and close the IME.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { keepTextFocusThroughTaps } from './keyboard-persisting-taps'
import { MobileSessionTitleBlock } from '../session/MobileSessionTitleBlock'
import type { SessionTitleCard } from '../session/use-session-title-card'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'

vi.mock('react-native', () => vi.importActual<typeof import('react-native')>('react-native-web'))

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

  it('keeps a focused field through a tap on the session title text, which opens the same card', () => {
    const host = document.createElement('div')
    const field = document.createElement('input')
    document.body.append(host, field)
    const details = mountFixture<SessionTitleCard>({
      openerRef: { current: null },
      titleRef: { current: null },
      boundaryRefs: { current: [] },
      titleActive: false,
      titleRequestedOpen: false,
      besideTabs: true,
      onAnchorLayout: () => {},
      toggle: () => {}
    })
    const root = createRoot(host)
    act(() =>
      root.render(
        createElement(MobileSessionTitleBlock, {
          title: 'workspace',
          connState: 'connected',
          details,
          meta: '',
          showConnectionRetry: false,
          onRetry: () => {}
        })
      )
    )
    const opener = host.querySelector('[aria-expanded]')
    const text = Array.from(opener?.querySelectorAll('*') ?? []).find(
      (node) => node.textContent === 'workspace'
    )
    expect(details.openerRef.current).toBe(opener)
    if (!text) {
      throw new Error('Title text is missing')
    }
    expect(pressKeepsFocus(text)).toBe(false)
    field.focus()
    expect(pressKeepsFocus(text)).toBe(true)
    expect(document.activeElement).toBe(field)
    act(() => root.unmount())
  })

  it('stops when released', () => {
    const { container, label, liveInput } = plant()
    keepTextFocusThroughTaps(container, 'always')()
    liveInput.focus()
    expect(pressKeepsFocus(label)).toBe(false)
  })
})
