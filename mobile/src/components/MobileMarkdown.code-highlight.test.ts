import { createElement } from 'react'
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileMarkdown } from './MobileMarkdown'
import { colors } from '../theme/mobile-theme'

vi.mock('react-native', () => ({
  Linking: { openURL: vi.fn() },
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

function textLeafColors(renderer: ReactTestRenderer): unknown[] {
  return renderer.root
    .findAll((node) => node.type === ('Text' as never))
    .map((node) => (Array.isArray(node.props.style) ? node.props.style : [node.props.style]))
    .flat()
    .map((style) => (style as { color?: unknown } | undefined)?.color)
}

describe('MobileMarkdown code highlighting', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render(content: string): ReactTestRenderer {
    act(() => {
      renderer = create(createElement(MobileMarkdown, { content }))
    })
    return renderer!
  }

  it('preserves the code text of a highlighted fence', () => {
    const rendered = render('```ts\nconst answer = 42\n```')
    // The concatenation of the segment Text runs equals the original code.
    const codeRun = rendered.root
      .findAll((node) => node.type === ('Text' as never) && node.props.selectable === true)
      .map(flattenText)
      .join('')
    expect(codeRun).toContain('const answer = 42')
  })

  it('colors a keyword differently from plain text (highlighting is wired)', () => {
    const rendered = render('```ts\nconst answer = 42\n```')
    expect(textLeafColors(rendered)).toContain(colors.syntaxKeyword)
  })

  it('renders an unknown/blank language fence as plain code without crashing', () => {
    const rendered = render('```\njust text\n```')
    const codeRun = rendered.root
      .findAll((node) => node.type === ('Text' as never) && node.props.selectable === true)
      .map(flattenText)
      .join('')
    expect(codeRun).toContain('just text')
  })
})
