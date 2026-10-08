import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileMarkdown } from './MobileMarkdown'

vi.mock('react-native', () => ({
  Image: 'Image',
  Linking: { openURL: () => Promise.resolve() },
  Platform: { OS: 'ios' },
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

/** The pinch scale entry MobileMarkdown appends last on a scaled style; null at scale 1. */
function scaleEntry(node: ReactTestInstance): unknown {
  const style = node.props.style
  return Array.isArray(style) ? style[style.length - 1] : null
}

function textByContent(renderer: ReactTestRenderer, content: string): ReactTestInstance {
  const match = renderer.root
    .findAll((node) => node.type === ('Text' as never))
    .find((node) => flattenText(node) === content)
  expect(match, `no text node ${JSON.stringify(content)}`).toBeDefined()
  return match!
}

describe('MobileMarkdown textScale', () => {
  const sources = { 'docs/shot.png': 'data:image/png;base64,AAA' }
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render(content: string, textScale?: number): ReactTestRenderer {
    act(() => {
      renderer = create(
        createElement(MobileMarkdown, { content, imageSources: sources, textScale })
      )
    })
    return renderer!
  }

  const TABLE = `| Skill | Shot |\n| --- | --- |\n| brainstorm | ![shot](docs/shot.png) |`

  it('scales table cell text and inline images with textScale', () => {
    const tree = render(TABLE, 1.5)
    // 12/17 bases from tableCell: 12 * 1.5 = 18, 17 * 1.5 = 25.5.
    expect(scaleEntry(textByContent(tree, 'Skill'))).toEqual({ fontSize: 18, lineHeight: 25.5 })
    expect(scaleEntry(textByContent(tree, 'brainstorm'))).toEqual({
      fontSize: 18,
      lineHeight: 25.5
    })
    // The inline thumbnail inside the table cell grows with the same multiplier.
    const image = tree.root.find((node) => String(node.type) === 'Image')
    expect(image.props.style).toEqual({ width: 150, height: 195, marginVertical: 2 })
  })

  it('leaves table sizes alone at the default scale', () => {
    const tree = render(TABLE)
    expect(scaleEntry(textByContent(tree, 'Skill'))).toBeNull()
    const image = tree.root.find((node) => String(node.type) === 'Image')
    expect(image.props.style.width).toBe(100)
  })

  it('scales headings, quotes, and code blocks with textScale', () => {
    const tree = render('# Title\n\n### Sub\n\n> quoted\n\n```js\nconst x\n```', 1.5)
    // headingLarge 15/21, heading 14/20, quoteText 13/19, codeText 12/17.
    expect(scaleEntry(textByContent(tree, 'Title'))).toEqual({ fontSize: 22.5, lineHeight: 31.5 })
    expect(scaleEntry(textByContent(tree, 'Sub'))).toEqual({ fontSize: 21, lineHeight: 30 })
    expect(scaleEntry(textByContent(tree, 'quoted'))).toEqual({ fontSize: 19.5, lineHeight: 28.5 })
    expect(scaleEntry(textByContent(tree, 'const x'))).toEqual({
      fontSize: 18,
      lineHeight: 25.5
    })
  })

  it('scales list markers with the list text', () => {
    const tree = render('- item', 1.5)
    expect(scaleEntry(textByContent(tree, '-'))).toEqual({ fontSize: 19.5, lineHeight: 28.5 })
    expect(scaleEntry(textByContent(tree, 'item'))).toEqual({ fontSize: 21, lineHeight: 30 })
  })
})
