import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  Bold: 'Bold',
  Code2: 'Code2',
  FileCode2: 'FileCode2',
  Heading1: 'Heading1',
  Heading2: 'Heading2',
  Heading3: 'Heading3',
  ImageIcon: 'ImageIcon',
  Italic: 'Italic',
  Link: 'Link',
  List: 'List',
  ListOrdered: 'ListOrdered',
  ListTodo: 'ListTodo',
  Pilcrow: 'Pilcrow',
  Quote: 'Quote',
  Strikethrough: 'Strikethrough'
}))

import { MobileRichMarkdownToolbar } from './MobileRichMarkdownToolbar'
import type { MobileRichMarkdownCommand } from './mobile-rich-markdown-editor-contract'

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

function render(editable: boolean, onCommand: (command: MobileRichMarkdownCommand) => void) {
  act(() => {
    renderer = create(createElement(MobileRichMarkdownToolbar, { editable, onCommand }))
  })
  return renderer!.root.findAll((node) => String(node.type) === 'Pressable')
}

describe('the rich Markdown toolbar', () => {
  it('routes named controls to their editor commands', () => {
    const onCommand = vi.fn()
    const buttons = render(true, onCommand)
    for (const [label, command] of [
      ['Bold', 'bold'],
      ['Link', 'link'],
      ['Inline code', 'inlineCode']
    ] as const) {
      onCommand.mockClear()
      const button = buttons.find((candidate) => candidate.props.accessibilityLabel === label)
      expect(button).toBeDefined()
      act(() => button!.props.onPress())
      expect(onCommand.mock.calls).toEqual([[command]])
    }
  })

  it('disables every button against a document that cannot be edited', () => {
    const buttons = render(false, vi.fn())
    expect(buttons.filter((button) => button.props.disabled !== true)).toEqual([])
  })
})
