import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileMarkdown } from './MobileMarkdown'

// Disable selectable transcript spans only on Android, where scrolling selects TextView words; sibling iOS suite proves range selection stays enabled there.
vi.mock('react-native', () => ({
  Linking: { openURL: () => Promise.resolve() },
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

vi.mock('./pr-sidebar/MermaidDiagram', () => ({ MermaidDiagram: 'MermaidDiagram' }))
vi.mock('./MobileSourceCopyButton', () => ({ MobileSourceCopyButton: 'MobileSourceCopyButton' }))

const CONTENT = [
  '# Heading',
  'A paragraph with **bold**, `code` and https://example.com/link.',
  '> quoted',
  '- item one',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '```',
  'fenced()',
  '```'
].join('\n')

describe('MobileMarkdown on Android', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render(props: Parameters<typeof MobileMarkdown>[0]): ReactTestInstance[] {
    act(() => {
      renderer = create(createElement(MobileMarkdown, props))
    })
    return renderer!.root.findAll((node) => String(node.type) === 'Text')
  }

  const tappable = (nodes: ReactTestInstance[]) =>
    nodes.filter((node) => typeof node.props.onPress === 'function')

  it('renders the transcript with no selectable span, leaving untouched spans alone', () => {
    const all = render({ content: CONTENT, rangeSelectable: true })
    expect(all.length).toBeGreaterThan(5)
    expect(all.filter((node) => node.props.selectable === true)).toHaveLength(0)
    // Leave inline selection unset: false becomes web userSelect:none and breaks inherited behavior.
    const links = tappable(all)
    expect(links.length).toBeGreaterThan(0)
    for (const node of links) {
      expect(node.props.selectable).toBeUndefined()
    }
  })

  it('routes a long press on a tappable span or image to the row, so neither swallows it', () => {
    const onLongPress = vi.fn()
    const content = `${CONTENT}\n\n![diagram](https://example.com/diagram.png)`
    const all = render({ content, rangeSelectable: true, onLongPress })
    const links = tappable(all)
    expect(links.length).toBeGreaterThan(0)
    for (const node of links) {
      expect(node.props.onLongPress).toBe(onLongPress)
    }
    expect(all.filter((node) => !node.props.onPress && node.props.onLongPress)).toHaveLength(0)
    const images = renderer!.root.findAll(
      (node) => String(node.type) === 'Pressable' && typeof node.props.onPress === 'function'
    )
    expect(images.length).toBeGreaterThan(0)
    for (const node of images) {
      expect(node.props.onLongPress).toBe(onLongPress)
    }
  })

  it('keeps other surfaces (task comments, previews) selectable as before', () => {
    const all = render({ content: CONTENT })
    expect(all.filter((node) => node.props.selectable === true).length).toBeGreaterThan(0)
  })
})
