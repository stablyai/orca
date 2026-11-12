// @vitest-environment happy-dom
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('react-native', async () => {
  const React = await import('react')
  const host =
    (name: string) =>
    ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement(name, props, children)
  return {
    // Mock native external-link opener’s module-load import or missing named export prevents collection.
    Linking: { openURL: async () => true },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    TextInput: host('TextInput'),
    View: host('View')
  }
})

// Mock toggle icons: lucide barrel imports absent LucideProvider and cannot load in Vitest.
vi.mock('lucide-react-native', () => ({
  Bold: () => null,
  Code: () => null,
  Code2: () => null,
  Eye: () => null,
  FileCode2: () => null,
  Heading1: () => null,
  Heading2: () => null,
  Heading3: () => null,
  ImageIcon: () => null,
  Italic: () => null,
  Link: () => null,
  List: () => null,
  ListOrdered: () => null,
  ListTodo: () => null,
  Pilcrow: () => null,
  Quote: () => null,
  Strikethrough: () => null
}))

vi.mock('./TextInputModal', async () => {
  const React = await import('react')
  return {
    TextInputModal: (props: Record<string, unknown>) => React.createElement('TextInputModal', props)
  }
})

import { MobileRichMarkdownEditor } from './MobileRichMarkdownEditor'

const renderers: ReactTestRenderer[] = []

// Match mocked host strings by predicate; findAllByType expects component ElementType.
function findHosts(renderer: ReactTestRenderer, type: string) {
  return renderer.root.findAll((node) => node.type === type)
}

function render(
  element: React.ReactElement,
  node: HTMLElement = document.createElement('div')
): ReactTestRenderer {
  let renderer: ReactTestRenderer | null = null
  document.body.appendChild(node)
  act(() => {
    renderer = create(element, { createNodeMock: () => node })
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
  document.body.innerHTML = ''
  document.head.innerHTML = ''
})

describe('the rich markdown editor on the page', () => {
  it('mounts the editor document with its content and reports edits to the host', () => {
    const host = document.createElement('div')
    const onChange = vi.fn()
    const renderer = render(
      createElement(MobileRichMarkdownEditor, {
        content: '# Title\n\nbody',
        editable: true,
        onChange
      }),
      host
    )
    const surface = host.querySelector<HTMLElement>('#editor')!
    expect(surface.querySelector('h1')?.textContent).toBe('Title')
    expect(surface.querySelector('p')?.textContent).toBe('body')
    expect(surface.getAttribute('contenteditable')).toBe('true')
    expect(onChange).not.toHaveBeenCalled()
    expect(findHosts(renderer, 'TextInput')).toEqual([])

    act(() => {
      surface.innerHTML = '<p>edited</p>'
      surface.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onChange.mock.calls).toEqual([['edited']])
  })

  it('keeps the document and toolbar read-only until editing is enabled', () => {
    const host = document.createElement('div')
    const onChange = vi.fn()
    const editor = (editable: boolean) =>
      createElement(MobileRichMarkdownEditor, {
        content: 'body',
        editable,
        onChange
      })
    const renderer = render(editor(false), host)
    const surface = host.querySelector<HTMLElement>('#editor')!
    const buttons = findHosts(renderer, 'Pressable')
    expect(buttons.length).toBeGreaterThan(0)
    expect(buttons.filter((node) => node.props.disabled !== true)).toEqual([])
    expect(surface.getAttribute('contenteditable')).toBe('false')
    act(() => {
      surface.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onChange).not.toHaveBeenCalled()

    act(() => renderer.update(editor(true)))
    const enabled = findHosts(renderer, 'Pressable')
    expect(enabled).toHaveLength(buttons.length)
    expect(enabled.filter((node) => node.props.disabled === true)).toEqual([])
    expect(surface.getAttribute('contenteditable')).toBe('true')
    act(() => {
      surface.innerHTML = '<p>accepted</p>'
      surface.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onChange.mock.calls).toEqual([['accepted']])
  })
})
