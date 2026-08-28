import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_TOOL_DETAIL_LENGTH } from '../../../src/shared/native-chat-tool-summary'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    Image: 'Image',
    Pressable: 'Pressable',
    Text: ({ children, ...props }: { children?: unknown }) =>
      React.createElement('Text', props, children),
    View: ({ children, ...props }: { children?: unknown }) =>
      React.createElement('View', props, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
  }
})
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  ChevronDown: 'ChevronDown',
  Copy: 'Copy',
  SquareChevronRight: 'SquareChevronRight'
}))
vi.mock('../components/MobileMarkdown', () => ({ MobileMarkdown: 'MobileMarkdown' }))

import { MobileNativeChatMessage } from './MobileNativeChatMessage'

function userMessage(blocks: NativeChatMessage['blocks']): NativeChatMessage {
  return { id: 'u1', role: 'user', blocks, timestamp: null, source: 'transcript' }
}

function toolMessage(blocks: NativeChatMessage['blocks']): NativeChatMessage {
  return { id: 'a1', role: 'assistant', blocks, timestamp: null, source: 'transcript' }
}

describe('MobileNativeChatMessage', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render(
    message: NativeChatMessage,
    props: { toolsExpanded?: boolean; fontScale?: number } = {}
  ): ReactTestRenderer {
    act(() => {
      renderer = create(createElement(MobileNativeChatMessage, { message, ...props }))
    })
    return renderer!
  }

  const textIn = (node: ReactTestInstance): string[] =>
    node.findAllByType('Text' as never).map((text) => String(text.children.join('')))

  it('renders a loadable preview URI as an image thumbnail', () => {
    const tree = render(userMessage([{ type: 'image-ref', url: 'file:///a.jpg', alt: 'a photo' }]))
    const image = tree.root.findByType('Image' as never)
    expect(image.props.source).toEqual({ uri: 'file:///a.jpg' })
    expect(image.props.accessibilityLabel).toBe('a photo')
  })

  it('prefers the url over the path when both are present', () => {
    const tree = render(
      userMessage([{ type: 'image-ref', url: 'file:///local.jpg', path: '/tmp/host.png' }])
    )
    expect(tree.root.findByType('Image' as never).props.source).toEqual({
      uri: 'file:///local.jpg'
    })
  })

  it('falls back to a text placeholder for a bare host path', () => {
    // A host temp path (e.g. on an SSH host) is not loadable on the device.
    const tree = render(userMessage([{ type: 'image-ref', path: '/tmp/host.png' }]))
    expect(tree.root.findAllByType('Image' as never)).toHaveLength(0)
    const texts = tree.root
      .findAllByType('Text' as never)
      .map((node) => String(node.children.join('')))
    expect(texts.some((text) => text.includes('/tmp/host.png'))).toBe(true)
  })

  it('labels a tool row with the target path instead of raw input JSON', () => {
    const tree = render(
      toolMessage([{ type: 'tool-call', name: 'Read', input: { file_path: 'src/index.ts' } }]),
      { toolsExpanded: true }
    )
    const texts = textIn(tree.root)
    expect(texts).toContain('src/index.ts')
    expect(texts.some((text) => text.includes('"file_path":"src/index.ts"'))).toBe(false)
  })

  it('bounds expanded diff-less tool input before native text layout', () => {
    const tree = render(
      toolMessage([
        { type: 'tool-call', name: 'CustomTool', input: { payload: 'x'.repeat(100_000) } }
      ]),
      { toolsExpanded: true }
    )
    const detail = textIn(tree.root).find((text) => text.startsWith('{\n'))
    expect(detail).toHaveLength(MAX_TOOL_DETAIL_LENGTH + 1)
    expect(detail?.endsWith('…')).toBe(true)
  })

  it('expands formatted detail for a collapsed JSON-string tool input', () => {
    const tree = render(
      toolMessage([
        {
          type: 'tool-call',
          name: 'CustomTool',
          input: '{"cmd":"git status","description":"Inspect changes"}'
        }
      ])
    )
    const pressableWith = (label: string): ReactTestInstance =>
      tree.root.findAllByType('Pressable' as never).find((node) => textIn(node).includes(label))!

    act(() => pressableWith('1×').props.onPress())
    // The row label is the command, and the detail stays closed until tapped.
    expect(textIn(tree.root)).toContain('git status')
    expect(textIn(tree.root).some((text) => text.startsWith('{\n'))).toBe(false)

    act(() => pressableWith('CustomTool').props.onPress())
    expect(textIn(tree.root)).toContain(
      '{\n  "cmd": "git status",\n  "description": "Inspect changes"\n}'
    )
  })

  it('does not echo the row label as detail when a row has nothing to expand', () => {
    // The Tools toggle opens every row at once, bypassing the tap guard — a row
    // whose formatted input is its own label would echo itself in a panel that
    // no tap can dismiss.
    const tree = render(toolMessage([{ type: 'tool-call', name: 'ListTodos', input: '{}' }]), {
      toolsExpanded: true
    })
    expect(textIn(tree.root).filter((text) => text === '{}')).toHaveLength(1)
    // The chevron has to agree with the panel, or the row claims to be open over
    // nothing and the tap that would close it is guarded off. Only the run header
    // is open here; the row itself stays collapsed.
    expect(tree.root.findAllByType('ChevronDown' as never)).toHaveLength(1)
    expect(tree.root.findAllByType('SquareChevronRight' as never)).toHaveLength(1)
  })

  it('does not expand a plain input that already fits in the row label', () => {
    const input = 'x'.repeat(60)
    const tree = render(toolMessage([{ type: 'tool-call', name: 'CustomTool', input }]), {
      toolsExpanded: true
    })
    expect(textIn(tree.root).filter((text) => text === input)).toHaveLength(1)
    expect(tree.root.findAllByType('ChevronDown' as never)).toHaveLength(1)
    expect(tree.root.findAllByType('SquareChevronRight' as never)).toHaveLength(1)
  })

  it('renders a system notice as a banner, not an agent bubble with copy controls', () => {
    const tree = render({
      id: 'notice-1',
      role: 'system',
      blocks: [{ type: 'text', text: 'Please run /login in Claude Code.' }],
      timestamp: null,
      source: 'transcript',
      notice: { level: 'warning' }
    })
    expect(textIn(tree.root)).toContain('Please run /login in Claude Code.')
    expect(tree.root.findAllByType('Pressable' as never)).toHaveLength(0)
    const banner = tree.root
      .findAllByType('View' as never)
      .find((node) => node.props.accessibilityRole === 'alert')
    expect(banner).toBeTruthy()
  })
  it('makes agent notice text selectable and respects font scaling', () => {
    const tree = render(
      {
        id: 'notice-1',
        role: 'system',
        blocks: [{ type: 'text', text: 'Please run /login to enroll this device.' }],
        timestamp: null,
        source: 'transcript',
        notice: { level: 'warning' }
      },
      { fontScale: 1.5 }
    )
    const notice = tree.root
      .findAllByType('Text' as never)
      .find((node) => String(node.children.join('')).includes('/login'))
    expect(notice, 'notice text node').toBeDefined()
    expect(notice!.props.selectable).toBe(true)
    expect(notice!.props.style).toContainEqual({ fontSize: 25.5, lineHeight: 34.5 })
  })

  it('renders a metadata-absent system row through the ordinary message fallback', () => {
    const tree = render({
      id: 'legacy-system-1',
      role: 'system',
      blocks: [{ type: 'text', text: 'Provider status from an older host.' }],
      timestamp: null,
      source: 'transcript'
    })

    expect(tree.root.findByType('MobileMarkdown' as never).props.content).toBe(
      'Provider status from an older host.'
    )
    expect(tree.root.findAllByType('Pressable' as never)).not.toHaveLength(0)
    expect(
      tree.root
        .findAllByType('View' as never)
        .some((node) => node.props.accessibilityRole === 'alert')
    ).toBe(false)
  })
})
