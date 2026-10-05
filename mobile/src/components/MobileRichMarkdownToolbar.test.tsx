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

import {
  MOBILE_RICH_MARKDOWN_TOOLBAR_COMMANDS,
  MobileRichMarkdownToolbar
} from './MobileRichMarkdownToolbar'
import type { MobileRichMarkdownCommand } from './mobile-rich-markdown-editor-contract'

/**
 * The one row of controls both surfaces render.
 *
 * The WebView turns a press into an injected `runCommand` and the page turns it into a call, and
 * neither difference belongs in the row. What is pinned here is the thing a second copy would have
 * drifted on: that the row names every command the contract has, exactly once, so an editor whose
 * document answers a command the toolbar cannot reach is a compile error rather than a control
 * nobody has.
 */
const CONTRACT_COMMANDS: MobileRichMarkdownCommand[] = [
  'paragraph',
  'heading1',
  'heading2',
  'heading3',
  'bold',
  'italic',
  'strike',
  'bulletList',
  'orderedList',
  'taskList',
  'quote',
  'inlineCode',
  'codeBlock',
  'link',
  'image'
]

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
  it('names every command in the contract, once', () => {
    expect([...MOBILE_RICH_MARKDOWN_TOOLBAR_COMMANDS].sort()).toEqual([...CONTRACT_COMMANDS].sort())
    expect(new Set(MOBILE_RICH_MARKDOWN_TOOLBAR_COMMANDS).size).toBe(15)
  })

  it('renders one labelled button per command and reports the press', () => {
    const onCommand = vi.fn()
    const buttons = render(true, onCommand)
    expect(buttons).toHaveLength(15)
    expect(buttons.map((button) => button.props.accessibilityLabel)).toEqual([
      'Body',
      'H1',
      'H2',
      'H3',
      'Bold',
      'Italic',
      'Strike',
      'Bullet list',
      'Numbered list',
      'Checklist',
      'Quote',
      'Link',
      'Image',
      'Inline code',
      'Code block'
    ])
    act(() => buttons[4]?.props.onPress())
    expect(onCommand.mock.calls).toEqual([['bold']])
  })

  it('disables every button against a document that cannot be edited', () => {
    const buttons = render(false, vi.fn())
    expect(buttons.filter((button) => button.props.disabled !== true)).toEqual([])
  })
})
