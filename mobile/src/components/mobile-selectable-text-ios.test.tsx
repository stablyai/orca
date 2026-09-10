import { createElement, Fragment } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
// Exercise the dependency's real span conversion without a native runtime.
vi.mock('react-native-uitextview', () => import('react-native-uitextview/src/Text'))
vi.mock('./MobileSelectableText', () => import('./MobileSelectableText.ios'))
vi.mock('./pr-sidebar/MermaidDiagram', () => ({ MermaidDiagram: 'MermaidDiagram' }))

let renderer: ReactTestRenderer | undefined
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  native.available = true
  vi.resetModules()
  vi.restoreAllMocks()
})

function render(element: React.ReactElement): ReactTestRenderer {
  act(() => {
    renderer = create(element)
  })
  return renderer!
}

function nodes(tree: ReactTestRenderer, name: string) {
  return tree.root.findAll((node) => node.type === name)
}

describe('iOS selectable text boundary', () => {
  it('preserves line-scoped keys when repeated inline spans update or disappear', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { MobileMarkdown } = await import('./MobileMarkdown')
    const onOpenFile = vi.fn()
    const line = '**same** [file](src/main.ts)'
    const tree = render(
      createElement(MobileMarkdown, {
        content: `${line}\n${line}`,
        rangeSelectable: true,
        onOpenFile
      })
    )
    expect(
      nodes(tree, 'RNUITextViewChild')
        .map((node) => node.props.text)
        .join('')
    ).toBe('same file\nsame file')
    act(() =>
      tree.update(
        createElement(MobileMarkdown, {
          content: `${line}\n**changed** [file](src/main.ts)`,
          rangeSelectable: true,
          onOpenFile
        })
      )
    )
    expect(
      nodes(tree, 'RNUITextViewChild')
        .map((node) => node.props.text)
        .join('')
    ).toBe('same file\nchanged file')
    act(() =>
      tree.update(
        createElement(MobileMarkdown, { content: line, rangeSelectable: true, onOpenFile })
      )
    )
    const spans = nodes(tree, 'RNUITextViewChild')
    expect(spans.map((node) => node.props.text).join('')).toBe('same file')
    act(() => spans.find((node) => node.props.text === 'file')!.props.onPress())
    expect(onOpenFile).toHaveBeenCalledExactlyOnceWith('src/main.ts')
    expect(errors.mock.calls.filter((args) => String(args[0]).includes('same key'))).toEqual([])
  })

  it.each([
    ['500', 'medium'],
    ['600', 'semibold'],
    ['700', 'bold']
  ] as const)('preserves font weight %s', async (fontWeight, expected) => {
    const { MobileSelectableText: Text } = await import('./MobileSelectableText.ios')
    const tree = render(createElement(Text, { selectable: true, style: { fontWeight } }, 'Weight'))
    expect(nodes(tree, 'RNUITextViewChild')[0]!.props.style.fontWeight).toBe(expected)
  })

  it('keeps fragments, arrays, newlines and nested styles in one native root', async () => {
    const { MobileSelectableText: Text } = await import('./MobileSelectableText.ios')
    const tree = render(
      createElement(
        Text,
        { selectable: true, style: { fontSize: 18 } },
        createElement(Fragment, null, 'Before ', ['one', '\n']),
        createElement(Text, { style: { fontWeight: '700' } }, 'bold'),
        createElement(Text, { style: { color: 'blue' } }, 'nested'),
        ' after'
      )
    )
    expect(nodes(tree, 'RNUITextView')).toHaveLength(1)
    expect(nodes(tree, 'Text')).toHaveLength(0)
    const spans = nodes(tree, 'RNUITextViewChild')
    expect(spans.map((node) => node.props.text).join('')).toBe('Before one\nboldnested after')
    expect(spans.find((node) => node.props.text === 'bold')?.props.style).toMatchObject({
      fontSize: 18,
      fontWeight: 'bold'
    })
    expect(spans.find((node) => node.props.text === 'nested')?.props.style).toMatchObject({
      fontSize: 18,
      color: 'blue'
    })
  })

  it('preserves Markdown text, inline styles and file-link callbacks', async () => {
    const { MobileMarkdown } = await import('./MobileMarkdown')
    const onOpenFile = vi.fn()
    const tree = render(
      createElement(MobileMarkdown, {
        content: 'Hello 😀 [src/main.ts](src/main.ts) and `code`.\nNext line.',
        rangeSelectable: true,
        onOpenFile
      })
    )
    const spans = nodes(tree, 'RNUITextViewChild')
    expect(spans.map((node) => node.props.text).join('')).toBe(
      'Hello 😀 src/main.ts and code.\nNext line.'
    )
    const link = spans.find((node) => node.props.text === 'src/main.ts')!
    expect(link.props.style.color).toBeDefined()
    act(() => link.props.onPress())
    expect(onOpenFile).toHaveBeenCalledExactlyOnceWith('src/main.ts')
    expect(nodes(tree, 'RNUITextView')).toHaveLength(1)
  })

  it('keeps ordinary button labels on React Native Text', async () => {
    const { MobileSelectableText: Text } = await import('./MobileSelectableText.ios')
    const tree = render(createElement(Text, null, 'Submit'))
    expect(nodes(tree, 'RNUITextView')).toHaveLength(0)
    expect(nodes(tree, 'Text')).toHaveLength(1)
  })

  it('uses native range selection only when Markdown opts in', async () => {
    const { MobileMarkdown } = await import('./MobileMarkdown')
    const tree = render(createElement(MobileMarkdown, { content: 'Transcript prose' }))
    expect(nodes(tree, 'RNUITextView')).toHaveLength(0)
    expect(
      nodes(tree, 'Text').find((node) => node.children.includes('Transcript prose'))?.props
        .selectable
    ).toBe(false)
    act(() =>
      tree.update(
        createElement(MobileMarkdown, { content: 'Transcript prose', rangeSelectable: true })
      )
    )
    expect(nodes(tree, 'RNUITextView')).toHaveLength(1)
  })

  it('keeps code-language labels on styled React Native Text', async () => {
    const { MobileMarkdown } = await import('./MobileMarkdown')
    const tree = render(
      createElement(MobileMarkdown, {
        content: '```ts\nconst value = 1\n```',
        rangeSelectable: true
      })
    )
    const label = nodes(tree, 'Text').find((node) => node.children.join('') === 'ts')!
    expect(label.props.style.textTransform).toBe('uppercase')
    expect(nodes(tree, 'RNUITextView')).toHaveLength(1)
  })

  it('falls back for older clients without the native view', async () => {
    native.available = false
    const { MobileSelectableText: Text } = await import('./MobileSelectableText.ios')
    const tree = render(
      createElement(Text, { selectable: true }, 'Old client ', createElement(Text, null, 'inline'))
    )
    expect(nodes(tree, 'RNUITextView')).toHaveLength(0)
    expect(nodes(tree, 'Text')).toHaveLength(2)
    expect(nodes(tree, 'Text')[0]!.props.selectable).toBe(true)
  })
})
