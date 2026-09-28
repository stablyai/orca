import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileMarkdown } from './MobileMarkdown'

vi.mock('react-native', () => ({
  Linking: { openURL: () => Promise.resolve() },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

vi.mock('./pr-sidebar/MermaidDiagram', () => ({ MermaidDiagram: 'MermaidDiagram' }))

type TestNode = {
  type: string
  props: Record<string, unknown>
  children: (TestNode | string)[] | null
}

/** Every Text that is not nested inside another Text, paired with the full prose
 *  it renders. Nested inline spans inherit selection, so only these carry it. */
function outermostTextNodes(
  node: TestNode | string,
  insideText = false
): { text: string; selectable: boolean }[] {
  if (typeof node === 'string') {
    return []
  }
  const children = node.children ?? []
  if (node.type === 'Text' && !insideText) {
    return [{ text: flattenText(node), selectable: node.props.selectable === true }]
  }
  return children.flatMap((child) => outermostTextNodes(child, insideText || node.type === 'Text'))
}

function flattenText(node: TestNode | string): string {
  if (typeof node === 'string') {
    return node
  }
  return (node.children ?? []).map(flattenText).join('')
}

function renderMarkdown(props: Parameters<typeof MobileMarkdown>[0]): TestNode {
  let renderer: ReactTestRenderer | null = null
  act(() => {
    renderer = create(createElement(MobileMarkdown, { rangeSelectable: true, ...props }))
  })
  const tree = renderer!.toJSON() as unknown as TestNode
  act(() => renderer!.unmount())
  return tree
}

function selectableFor(tree: TestNode, needle: string): boolean {
  const match = outermostTextNodes(tree).find((entry) => entry.text.includes(needle))
  if (!match) {
    throw new Error(`no Text rendered "${needle}"`)
  }
  return match.selectable
}

describe('MobileMarkdown selection', () => {
  afterEach(() => vi.clearAllMocks())

  // Paragraphs are the default block for agent prose, and were the one block
  // type left non-selectable when the others gained it.
  it.each([
    ['paragraph', 'Paragraph prose here.'],
    ['heading', 'Heading prose'],
    ['quote', 'Quote prose'],
    ['code', 'const code = 1'],
    ['list item', 'List item prose'],
    ['table header', 'Head A'],
    ['table cell', 'Cell A']
  ])('makes %s prose selectable', (_label, needle) => {
    const content = [
      '# Heading prose',
      '',
      'Paragraph prose here.',
      '',
      '> Quote prose',
      '',
      '```ts',
      'const code = 1',
      '```',
      '',
      '- List item prose',
      '',
      '| Head A | Head B |',
      '| --- | --- |',
      '| Cell A | Cell B |'
    ].join('\n')
    expect(selectableFor(renderMarkdown({ content }), needle)).toBe(true)
  })

  it('makes the empty-content fallback selectable', () => {
    const tree = renderMarkdown({ content: '', fallback: 'Fallback prose' })
    expect(selectableFor(tree, 'Fallback prose')).toBe(true)
  })

  it('keeps inline spans inside their selectable block rather than splitting it', () => {
    const tree = renderMarkdown({ content: 'Prose with `code` and **bold** inline.' })
    const blocks = outermostTextNodes(tree)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.selectable).toBe(true)
    expect(blocks[0]!.text).toBe('Prose with code and bold inline.')
  })
})
