import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseMobileMarkdown } from './mobile-markdown-parser'

const native = vi.hoisted(() => ({ available: true }))
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  UIManager: { hasViewManagerConfig: () => native.available },
  Linking: { openURL: vi.fn() },
  Text: 'Text',
  View: 'View',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  StyleSheet: {
    create: (styles: unknown) => styles,
    flatten: (style: unknown): object =>
      Array.isArray(style)
        ? Object.assign({}, ...style.flat(Infinity).filter(Boolean))
        : (style ?? {}),
    hairlineWidth: 1
  }
}))
vi.mock('react-native/Libraries/Utilities/codegenNativeComponent', () => ({
  default: (name: string) => name
}))
vi.mock('./MobileSelectableText', () => import('./MobileSelectableText.ios'))
vi.mock('./pr-sidebar/MermaidDiagram', () => ({ MermaidDiagram: 'MermaidDiagram' }))

let renderer: ReactTestRenderer | undefined
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  native.available = true
  vi.resetModules()
})

async function renderMarkdown(content: string): Promise<ReactTestRenderer> {
  const { MobileMarkdown } = await import('./MobileMarkdown')
  act(() => {
    renderer = create(createElement(MobileMarkdown, { content, rangeSelectable: true }))
  })
  return renderer!
}

function nodes(tree: ReactTestRenderer, name: string) {
  return tree.root.findAll((node) => node.type === name)
}

function runs(tree: ReactTestRenderer) {
  return nodes(tree, 'OrcaSelectableTextRun')
}

const REPLY = [
  '## Plan',
  'First paragraph',
  'wraps here.',
  '- one',
  '- two **bold**',
  '```ts',
  'const x = 1',
  '```',
  'After code.'
].join('\n')

describe('merged selectable prose', () => {
  it('groups consecutive prose blocks and leaves the rest standalone', async () => {
    const { groupProseBlocks } = await import('./mobile-markdown-merged-prose')
    const groups = groupProseBlocks(parseMobileMarkdown(REPLY))
    expect(groups.map((group) => (group.kind === 'prose' ? group.blocks.length : 'block'))).toEqual(
      [3, 'block', 1]
    )
  })

  it('renders each run of prose as one native text view', async () => {
    const tree = await renderMarkdown(REPLY)
    // Two prose runs plus the code block: once one view per block and list item.
    expect(nodes(tree, 'OrcaSelectableText')).toHaveLength(3)
    expect(nodes(tree, 'Text').filter((node) => node.props.style?.width)).toEqual([])
    expect(
      runs(tree)
        .map((node) => node.props.text)
        .join('')
    ).toBe('Plan\nFirst paragraph\nwraps here.\n-\tone\n-\ttwo boldconst x = 1After code.')
  })

  it('hangs list items under their text and spaces blocks like the unmerged layout', async () => {
    const { markdownBlockGap, markdownListIndent, markdownListItemGap } =
      await import('./mobile-markdown-styles')
    const tree = await renderMarkdown(REPLY)
    const paragraphOf = (text: string) => {
      const run = runs(tree).find((node) => node.props.text.includes(text))!
      return [run.props.paragraphHeadIndent, run.props.paragraphSpacing]
    }
    expect(paragraphOf('Plan')).toEqual([undefined, markdownBlockGap])
    // A soft break stays tight; the gap follows the block's last line.
    expect(paragraphOf('First paragraph')).toEqual([undefined, 0])
    expect(paragraphOf('wraps here.')).toEqual([undefined, markdownBlockGap])
    expect(paragraphOf('one')).toEqual([markdownListIndent, markdownListItemGap])
    // Adjacent plain strings share one native run.
    expect(runs(tree).map((node) => node.props.text)).toContain('\tone\n')
    // The run's last item ends the group, so nothing trails it.
    expect(paragraphOf('bold')).toEqual([markdownListIndent, 0])
    expect(paragraphOf('After code.')).toEqual([undefined, 0])
  })

  it('scales prose and list text while headings and markers keep their own style', async () => {
    const { MobileMarkdown } = await import('./MobileMarkdown')
    act(() => {
      renderer = create(
        createElement(MobileMarkdown, {
          content: '## Plan\nBody text\n1. step',
          rangeSelectable: true,
          // Native chat's scale at the default font size.
          textScale: 1.25
        })
      )
    })
    const styleOf = (text: string) => {
      const { fontSize, lineHeight, fontWeight, fontFamily, color } = runs(renderer!).find((node) =>
        node.props.text.includes(text)
      )!.props.style
      return { fontSize, lineHeight, fontWeight, fontFamily, color }
    }
    expect(styleOf('Plan')).toEqual({
      fontSize: 15,
      lineHeight: 21,
      fontWeight: 'bold',
      fontFamily: undefined,
      color: '#e0e0e0'
    })
    expect(styleOf('Body')).toEqual({
      fontSize: 13 * 1.25,
      lineHeight: 19 * 1.25,
      fontWeight: 'normal',
      fontFamily: undefined,
      color: '#e0e0e0'
    })
    expect(styleOf('step')).toEqual({
      fontSize: 14 * 1.25,
      lineHeight: 20 * 1.25,
      fontWeight: 'normal',
      fontFamily: undefined,
      color: '#e0e0e0'
    })
    expect(styleOf('1.')).toMatchObject({ fontSize: 13, fontFamily: 'monospace', color: '#a1a1a1' })
  })

  it('keeps inline links tappable inside merged prose', async () => {
    const { MobileMarkdown } = await import('./MobileMarkdown')
    const onOpenFile = vi.fn()
    act(() => {
      renderer = create(
        createElement(MobileMarkdown, {
          content: 'See [main](src/main.ts)\n- item `src/app.ts`',
          rangeSelectable: true,
          onOpenFile
        })
      )
    })
    act(() =>
      runs(renderer!)
        .find((node) => node.props.text === 'main')!
        .props.onPress()
    )
    act(() =>
      runs(renderer!)
        .find((node) => node.props.text === 'src/app.ts')!
        .props.onPress()
    )
    expect(onOpenFile.mock.calls).toEqual([['src/main.ts'], ['src/app.ts']])
  })

  it('keeps one view per block when the native view is missing', async () => {
    native.available = false
    // The adapter reads native support once at load, so register a fresh copy.
    vi.doMock('./MobileSelectableText', () => import('./MobileSelectableText.ios'))
    const tree = await renderMarkdown(REPLY)
    expect(nodes(tree, 'OrcaSelectableText')).toHaveLength(0)
    expect(nodes(tree, 'Text').filter((node) => node.props.style?.width === 22)).toHaveLength(2)
  })
})
