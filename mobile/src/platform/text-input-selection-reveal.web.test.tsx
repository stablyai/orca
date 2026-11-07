// @vitest-environment happy-dom
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { TextInput } from 'react-native'
import type * as ReactNative from 'react-native'
import { expect, it, vi } from 'vitest'
import { useTextInputSelectionReveal } from './text-input-selection-reveal.web'

vi.mock('react-native', () => vi.importActual<typeof ReactNative>('react-native-web'))

it('reveals the current caret after the field is capped and preserves later manual scrolling', async () => {
  const resized: (() => void)[] = []
  class LayoutObserver implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resized.push(() => callback([], this))
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', LayoutObserver)
  let height = 60
  let caretTop = 120
  vi.spyOn(HTMLTextAreaElement.prototype, 'clientWidth', 'get').mockReturnValue(300)
  vi.spyOn(HTMLTextAreaElement.prototype, 'clientHeight', 'get').mockImplementation(() => height)
  vi.spyOn(HTMLSpanElement.prototype, 'getClientRects').mockImplementation(() => {
    const rect = new DOMRect(0, caretTop, 1, 20)
    return {
      0: rect,
      length: 1,
      item: () => rect,
      [Symbol.iterator]: function* (): Generator<DOMRect, undefined, unknown> {
        yield rect
      }
    }
  })
  function Editor() {
    const input = useRef<TextInput>(null)
    useTextInputSelectionReveal(input)
    return (
      <TextInput ref={input} multiline defaultValue={'one\ntwo\nthree\nfour\nfive\nsix\nseven'} />
    )
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const paint = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  try {
    await act(async () => root.render(<Editor />))
    const field = container.querySelector('textarea')!
    field.focus()
    field.setSelectionRange(field.value.length, field.value.length)
    await act(async () => {
      height = 40
      resized.forEach((resize) => resize())
      await paint()
    })
    expect(field.scrollTop).toBe(100)
    await act(async () => {
      caretTop = 40
      field.setSelectionRange(4, 4)
      field.dispatchEvent(new Event('select'))
      await paint()
    })
    expect(field.scrollTop).toBe(40)
    expect(field.selectionStart).toBe(4)
    field.scrollTop = 65
    field.dispatchEvent(new Event('scroll'))
    await act(paint)
    expect(field.scrollTop).toBe(65)
    expect(document.activeElement).toBe(field)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})
