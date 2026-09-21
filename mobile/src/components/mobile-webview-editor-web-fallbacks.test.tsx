/**
 * The two `react-native-webview` consumers on the page, pinned through the test renderer.
 *
 * Both native components put their surface inside a `WebView`, which has no browser counterpart:
 * importing it runs a codegen lookup that throws, and the route manifest imports every route, so
 * one such import takes the whole bundle down rather than one editor. Ruling 8 is that each gets
 * the plain state it already degrades to and no second renderer, so what is pinned here is the
 * degradation: the text is still there and still editable, the formatting toolbar and the rendered
 * preview are not, and nothing reaches a WebView.
 */
import { createElement, createRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
// The unsuffixed path, which is what the component imports: under vitest that is the native
// module, and the page's `.web.ts` is what the C7.2 closure census judges against the 16px floor.
import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'

vi.mock('react-native', async () => {
  const React = await import('react')
  const host =
    (name: string) =>
    ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement(name, props, children)
  // The one mock that forwards a ref: the editor's `dismissKeyboard` blurs through it, and a
  // function component would have swallowed it.
  const TextInput = React.forwardRef<unknown, { children?: React.ReactNode }>(
    ({ children, ...props }, ref) => React.createElement('TextInput', { ...props, ref }, children)
  )
  return {
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    TextInput,
    View: host('View')
  }
})

import { MobileHtmlPreview } from './MobileHtmlPreview.web'
import { MobileRichMarkdownEditor } from './MobileRichMarkdownEditor.web'
import type { MobileRichMarkdownEditorHandle } from './MobileRichMarkdownEditor'

const renderers: ReactTestRenderer[] = []

/** By tag name through the predicate form: `findAllByType` is typed for components, and every
 *  element the mocks above render is a host string. */
function findHosts(renderer: ReactTestRenderer, type: string) {
  return renderer.root.findAll((node) => node.type === type)
}

/** `createNodeMock` is how a ref to a host element gets anything at all under this renderer, and
 *  the editor's `dismissKeyboard` reaches the field through one. */
function render(element: React.ReactElement, node?: unknown): ReactTestRenderer {
  let renderer: ReactTestRenderer | null = null
  act(() => {
    renderer = create(element, node === undefined ? undefined : { createNodeMock: () => node })
  })
  if (renderer === null) {
    throw new Error('nothing mounted')
  }
  renderers.push(renderer)
  return renderer
}

afterEach(() => {
  for (const renderer of renderers.splice(0)) {
    act(() => renderer.unmount())
  }
})

describe('the rich markdown editor on the page', () => {
  it('renders the source in one editable field and reports every edit', () => {
    const onChange = vi.fn()
    const renderer = render(
      createElement(MobileRichMarkdownEditor, {
        content: '# Title\n\nbody',
        editable: true,
        onChange
      })
    )

    const inputs = findHosts(renderer, 'TextInput')
    expect(inputs).toHaveLength(1)
    expect(inputs[0]?.props.value).toBe('# Title\n\nbody')
    expect(inputs[0]?.props.editable).toBe(true)
    act(() => inputs[0]?.props.onChangeText('# Title\n\nedited'))
    expect(onChange.mock.calls).toEqual([['# Title\n\nedited']])
  })

  it('renders no toolbar, which is the degradation rather than an omission', () => {
    // Fifteen commands drive a rich document this page does not have; a toolbar that could not
    // run them would be fifteen controls that do nothing.
    const renderer = render(
      createElement(MobileRichMarkdownEditor, {
        content: 'body',
        editable: true,
        onChange: vi.fn()
      })
    )
    expect(findHosts(renderer, 'Pressable')).toEqual([])
    expect(findHosts(renderer, 'ScrollView')).toEqual([])
  })

  it('locks the field when the document is not editable', () => {
    const renderer = render(
      createElement(MobileRichMarkdownEditor, {
        content: 'body',
        editable: false,
        onChange: vi.fn()
      })
    )
    expect(findHosts(renderer, 'TextInput')[0]?.props.editable).toBe(false)
  })

  it('sits on the text-input seam rather than on a size of its own', () => {
    // The floor itself is the `.web.ts` sibling's and is judged by the closure census; what is
    // pinned here is that this field is bound to the seam at all, which is what makes it move.
    const renderer = render(
      createElement(MobileRichMarkdownEditor, {
        content: 'body',
        editable: true,
        onChange: vi.fn()
      })
    )
    expect(findHosts(renderer, 'TextInput')[0]?.props.style.fontSize).toBe(TEXT_INPUT_FONT_SIZE)
  })

  it('dismisses the keyboard by blurring the field the caret is actually in', () => {
    // The native handle calls into the WebView's document; here the caret is in this field, and
    // react-native-web's `Keyboard.dismiss` is a stub that would have done nothing.
    const ref = createRef<MobileRichMarkdownEditorHandle>()
    const blur = vi.fn()
    render(
      createElement(MobileRichMarkdownEditor, {
        ref,
        content: 'body',
        editable: true,
        onChange: vi.fn()
      }),
      { blur }
    )
    act(() => ref.current?.dismissKeyboard())
    expect(blur).toHaveBeenCalledTimes(1)
  })

  it('never calls onKeyboardInsetChange, because there is no WebView to measure', () => {
    const onKeyboardInsetChange = vi.fn()
    render(
      createElement(MobileRichMarkdownEditor, {
        content: 'body',
        editable: true,
        onChange: vi.fn(),
        onKeyboardInsetChange
      })
    )
    expect(onKeyboardInsetChange).not.toHaveBeenCalled()
  })
})

describe('the html preview on the page', () => {
  it('renders the source the native component already falls back to', () => {
    const renderSource = vi.fn(() => createElement('SourceView', null))
    const renderer = render(createElement(MobileHtmlPreview, { html: '<h1>hi</h1>', renderSource }))
    expect(findHosts(renderer, 'SourceView')).toHaveLength(1)
    expect(renderSource).toHaveBeenCalledTimes(1)
  })

  it('renders no toggle, because there is no preview to flip to', () => {
    // A control that can only be in one position is a control that lies: the artifact has no
    // sandbox on the page, so the Preview half of the toggle goes with it.
    const renderer = render(
      createElement(MobileHtmlPreview, {
        html: '<h1>hi</h1>',
        renderSource: () => createElement('SourceView', null)
      })
    )
    expect(findHosts(renderer, 'Pressable')).toEqual([])
  })

  it('never renders the html itself, which is the whole of ruling 8', () => {
    const renderer = render(
      createElement(MobileHtmlPreview, {
        html: '<script>alert(1)</script>',
        renderSource: () => createElement('SourceView', null)
      })
    )
    // Agent-produced HTML, and the page has no frame to sandbox it in: the policy carries
    // frame-src 'none' and child-src 'none'.
    expect(JSON.stringify(renderer.toJSON())).not.toContain('alert(1)')
  })
})
