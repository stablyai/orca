import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileMarkdown } from './MobileMarkdown'

vi.mock('react-native', () => ({
  Linking: { openURL: vi.fn(() => Promise.resolve()) },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('./pr-sidebar/MermaidDiagram', () => ({ MermaidDiagram: 'MermaidDiagram' }))

function flattenText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : flattenText(child)))
    .join('')
}

describe('MobileMarkdown text selection', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('makes every Markdown-visible Text path selectable', () => {
    const content = [
      'Ordinary agent prose.',
      '# Agent heading',
      '> Quoted guidance',
      '- Listed action',
      'Use `inlineCode` here.',
      '```ts\nconst answer = 42\n```',
      '| Name | State |\n| --- | --- |\n| Orca | Ready |',
      '![Architecture diagram](https://example.com/diagram.png)'
    ].join('\n\n')

    act(() => {
      renderer = create(createElement(MobileMarkdown, { content }))
    })

    const textNodes = renderer!.root.findAll((node) => node.type === ('Text' as never))
    const visibleText = textNodes.map(flattenText)
    expect(visibleText).toEqual(
      expect.arrayContaining([
        'Ordinary agent prose.',
        'Agent heading',
        'Quoted guidance',
        'Listed action',
        'inlineCode',
        'ts',
        'const answer = 42',
        'Name',
        'Orca',
        'Architecture diagram',
        'https://example.com/diagram.png'
      ])
    )
    for (const node of textNodes) {
      expect(
        node.props.selectable,
        `${JSON.stringify(flattenText(node))} should be selectable`
      ).toBe(true)
    }
  })

  it('preserves the active paragraph Text while prose streams', () => {
    act(() => {
      renderer = create(createElement(MobileMarkdown, { content: 'Streaming response' }))
    })
    const initialParagraph = renderer!.root.findByType('Text' as never)

    act(() => {
      renderer!.update(createElement(MobileMarkdown, { content: 'Streaming response continues' }))
    })

    const updatedParagraph = renderer!.root.findByType('Text' as never)
    expect(updatedParagraph).toBe(initialParagraph)
    expect(flattenText(updatedParagraph)).toBe('Streaming response continues')
  })
})
