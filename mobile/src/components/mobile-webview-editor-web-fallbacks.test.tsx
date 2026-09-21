/**
 * The two `react-native-webview` consumers on the page, pinned through the test renderer.
 *
 * Both native components put their surface inside a `WebView`, which has no browser counterpart:
 * importing it runs a codegen lookup that throws, and the route manifest imports every route, so
 * one such import takes the whole bundle down rather than one editor.
 *
 * The two are no longer in the same state. Ruling 26 makes C7.6's fallbacks debt rather than done,
 * and C7.10's PR A has already paid it for the HTML preview: it renders the artifact in a sealed
 * `srcdoc` frame with the toggle intact, so what is pinned for it here is the frame's shape and the
 * toggle's two positions. What a browser does with that frame is not a question this renderer can
 * answer and is measured in `mobile-web-app-html-preview-render.test.mjs` instead. The rich Markdown
 * editor is still the plain field, and its degradation is still what is pinned below.
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
    // The native preview's external-link opener reaches for this at module load, and a named import
    // missing from a mocked module throws before any case runs.
    Linking: { openURL: async () => true },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    TextInput,
    View: host('View')
  }
})

// The preview's toggle carries two icons, and `lucide-react-native` imports a `LucideProvider` its
// own context module does not export, so the real barrel does not load under vitest at all.
vi.mock('lucide-react-native', () => ({
  Code: () => null,
  Eye: () => null
}))

// Mocked so the native sibling can be rendered beside the web one for the toggle case below: the real
// import is the codegen lookup this whole file exists because of.
vi.mock('react-native-webview', async () => {
  const React = await import('react')
  return {
    WebView: ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement('WebView', props, children)
  }
})

import { MobileHtmlPreview, MOBILE_HTML_PREVIEW_SANDBOX } from './MobileHtmlPreview.web'
import { MobileHtmlPreview as PhoneHtmlPreview } from './MobileHtmlPreview'
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
  const renderSourceMarker = () => createElement('SourceView', null)

  it('renders the artifact in a frame that can run nothing, and keeps the toggle', () => {
    const renderer = render(
      createElement(MobileHtmlPreview, { html: '<h1>hi</h1>', renderSource: renderSourceMarker })
    )
    const frames = findHosts(renderer, 'iframe')
    expect(frames).toHaveLength(1)
    // The artifact reaches the frame as `srcDoc`, which the browser parses inside it. Neither
    // `allow-scripts` nor `allow-same-origin`, which is the whole of what makes that safe.
    expect(frames[0]?.props.srcDoc).toBe('<h1>hi</h1>')
    expect(frames[0]?.props.sandbox).toBe(MOBILE_HTML_PREVIEW_SANDBOX)
    expect(MOBILE_HTML_PREVIEW_SANDBOX.split(' ')).not.toContain('allow-scripts')
    expect(MOBILE_HTML_PREVIEW_SANDBOX.split(' ')).not.toContain('allow-same-origin')
    // Both positions of the toggle exist, which is what stops it being a control that lies.
    expect(findHosts(renderer, 'Pressable')).toHaveLength(2)
  })

  it('shows the source when the toggle is flipped, and takes the frame away with it', () => {
    const renderSource = vi.fn(renderSourceMarker)
    const renderer = render(createElement(MobileHtmlPreview, { html: '<h1>hi</h1>', renderSource }))
    expect(findHosts(renderer, 'SourceView')).toHaveLength(0)

    const toSource = findHosts(renderer, 'Pressable').find(
      (node) => node.props.accessibilityLabel === 'View HTML source'
    )
    expect(toSource).toBeDefined()
    act(() => toSource?.props.onPress())

    expect(findHosts(renderer, 'SourceView')).toHaveLength(1)
    expect(renderSource).toHaveBeenCalled()
    // The artifact is not parsed anywhere while Source is showing.
    expect(findHosts(renderer, 'iframe')).toHaveLength(0)
  })

  // Both siblings, one case: the toggle is a pair of tabs and a reader has to be told which one is
  // showing. The two toolbars are the same code in two files, so a change to one that does not reach
  // the other reds here rather than reaching a phone as a toggle that announces nothing.
  for (const [surface, Preview] of [
    ['the page', MobileHtmlPreview],
    ['a phone', PhoneHtmlPreview]
  ] as const) {
    it(`says which side of the toggle is showing, on ${surface}`, () => {
      const renderer = render(
        createElement(Preview, { html: '<h1>hi</h1>', renderSource: renderSourceMarker })
      )
      const toggles = () => findHosts(renderer, 'Pressable')
      expect(toggles()).toHaveLength(2)
      expect(toggles().map((node) => node.props.accessibilityRole)).toEqual(['tab', 'tab'])
      // The pair's own container, so the two tabs are a set rather than two loose ones.
      expect(
        findHosts(renderer, 'View').filter((node) => node.props.accessibilityRole === 'tablist')
      ).toHaveLength(1)
      // The showing side, which is what a screen reader has no other way to learn: the active
      // position is styling and styling is not announced.
      expect(toggles().map((node) => node.props.accessibilityState?.selected)).toEqual([
        true,
        false
      ])

      act(() => toggles()[1]?.props.onPress())
      expect(toggles().map((node) => node.props.accessibilityState?.selected)).toEqual([
        false,
        true
      ])
    })
  }

  it('never puts the artifact anywhere but the frame', () => {
    const renderer = render(
      createElement(MobileHtmlPreview, {
        html: '<script>alert(1)</script>',
        renderSource: renderSourceMarker
      })
    )
    const tree = JSON.stringify(renderer.toJSON())
    // Once, as the frame's `srcDoc`, and nowhere else: not as a child, not as `dangerouslySetInnerHTML`,
    // not in a prop of the surrounding view.
    expect(findHosts(renderer, 'iframe')[0]?.props.srcDoc).toBe('<script>alert(1)</script>')
    expect(tree.split('alert(1)')).toHaveLength(2)
    expect(tree).not.toContain('dangerouslySetInnerHTML')
  })
})
