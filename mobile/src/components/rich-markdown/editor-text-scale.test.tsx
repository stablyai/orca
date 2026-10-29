// @vitest-environment happy-dom
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles }
}))
vi.mock('../MobileRichMarkdownToolbar', () => ({ MobileRichMarkdownToolbar: () => null }))
vi.mock('../TextInputModal', () => ({ TextInputModal: () => null }))
vi.mock('react-native-gesture-handler', () => ({ GestureDetector: 'GestureDetector' }))
vi.mock('../../platform/external-link', () => ({ openExternalLink: vi.fn() }))
vi.mock(
  '../../platform/text-input-font-size',
  async () => await import('../../platform/text-input-font-size.web')
)

import { MobileRichMarkdownEditor } from '../MobileRichMarkdownEditor'

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  document.body.innerHTML = ''
  document.head.innerHTML = ''
})

describe('rich Markdown text scale', () => {
  it('applies on mount and changes without replacing the document or caret', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const props = { content: 'Keep this caret', editable: true, onChange: vi.fn() }
    act(() => {
      renderer = create(createElement(MobileRichMarkdownEditor, { ...props, textScale: 1.25 }), {
        createNodeMock: () => host
      })
    })
    const editor = host.querySelector<HTMLElement>('#editor')!
    expect(editor.style.getPropertyValue('--markdown-text-scale')).toBe('1.25')
    const text = editor.querySelector('p')!.firstChild!
    const selection = window.getSelection()!
    const range = document.createRange()
    range.setStart(text, 4)
    range.collapse(true)
    selection.addRange(range)

    act(() => {
      renderer!.update(createElement(MobileRichMarkdownEditor, { ...props, textScale: 1.5 }))
    })
    expect(host.querySelector('#editor')).toBe(editor)
    expect(editor.querySelector('p')!.firstChild).toBe(text)
    expect(editor.style.getPropertyValue('--markdown-text-scale')).toBe('1.5')
    expect(Number.parseFloat(window.getComputedStyle(editor).fontSize)).toBeGreaterThanOrEqual(16)
    expect(selection.anchorNode).toBe(text)
    expect(selection.anchorOffset).toBe(4)
    expect(props.onChange).not.toHaveBeenCalled()

    act(() => {
      renderer!.update(createElement(MobileRichMarkdownEditor, props))
    })
    expect(editor.style.getPropertyValue('--markdown-text-scale')).toBe('1')
    act(() => {
      renderer!.update(createElement(MobileRichMarkdownEditor, { ...props, textScale: 0.5 }))
    })
    expect(editor.style.getPropertyValue('--markdown-text-scale')).toBe('0.5')
    expect(Number.parseFloat(window.getComputedStyle(editor).fontSize)).toBeGreaterThanOrEqual(16)
    expect(editor.querySelector('p')!.firstChild).toBe(text)
    expect(selection.anchorNode).toBe(text)
    expect(selection.anchorOffset).toBe(4)
  })
})
