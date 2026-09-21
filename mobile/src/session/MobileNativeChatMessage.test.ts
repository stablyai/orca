import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_TOOL_DETAIL_LENGTH } from '../../../src/shared/native-chat-tool-summary'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

vi.mock('react-native', async () => {
  const React = await import('react')
  const Text = ({ children, ...props }: { children?: unknown }): unknown =>
    React.createElement('Text', props, children)
  return {
    Animated: {
      Text,
      Value: class {
        setValue(): void {}
      },
      loop: (animation: unknown) => animation,
      sequence: () => ({ start: vi.fn(), stop: vi.fn() }),
      timing: () => ({ start: vi.fn(), stop: vi.fn() })
    },
    Image: 'Image',
    Pressable: 'Pressable',
    Text,
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
  SquareChevronRight: 'SquareChevronRight',
  SquareTerminal: 'SquareTerminal',
  Wrench: 'Wrench',
  ChevronRight: 'ChevronRight'
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
    props: {
      toolsExpanded?: boolean
      structuredActivityUi?: boolean
      activeTurnIsWorking?: boolean
      turnExpanded?: boolean
      turnStatus?: {
        startedAt: number | null
        thinking: boolean
        workedSeconds: number | null
      } | null
      onToggleTurn?: () => void
    } = {}
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

  describe('structured activity UI', () => {
    const runningCall = {
      type: 'tool-call' as const,
      name: 'Bash',
      input: { command: 'npm test' },
      state: 'running' as const
    }
    const settledCall = {
      type: 'tool-call' as const,
      name: 'Read',
      input: { file_path: 'a/b.ts' },
      state: 'completed' as const
    }

    it('shows the live tool label with a terminal glyph while a command runs', () => {
      const tree = render(toolMessage([runningCall]), {
        structuredActivityUi: true,
        activeTurnIsWorking: true
      })
      expect(textIn(tree.root)).toContain('Running npm test')
      expect(tree.root.findAllByType('SquareTerminal' as never)).toHaveLength(1)
      expect(tree.root.findAllByType('Wrench' as never)).toHaveLength(0)
    })

    it('uses the wrench glyph for a non-command tool', () => {
      const tree = render(
        toolMessage([
          { type: 'tool-call', name: 'Read', input: { file_path: 'a/b.ts' }, state: 'running' }
        ]),
        { structuredActivityUi: true, activeTurnIsWorking: true }
      )
      expect(textIn(tree.root)).toContain('Running Read a/b.ts')
      expect(tree.root.findAllByType('Wrench' as never)).toHaveLength(1)
    })

    it('falls back to the collapsed count row once the run settles', () => {
      const tree = render(toolMessage([settledCall]), {
        structuredActivityUi: true,
        activeTurnIsWorking: true
      })
      expect(textIn(tree.root)).not.toContain('Running Read a/b.ts')
      expect(textIn(tree.root)).toContain('1×')
    })

    it("hides a completed turn's activity until the turn caret discloses it", () => {
      const collapsed = render(toolMessage([settledCall]), {
        structuredActivityUi: true,
        activeTurnIsWorking: false
      })
      expect(textIn(collapsed.root)).not.toContain('1×')
      act(() => collapsed.unmount())

      const disclosed = render(toolMessage([settledCall]), {
        structuredActivityUi: true,
        activeTurnIsWorking: false,
        turnExpanded: true
      })
      expect(textIn(disclosed.root)).toContain('1×')
    })

    it('lets the global Tools toggle reveal a hidden settled run', () => {
      // Otherwise the composer's Tools control is a no-op on every settled turn.
      const tree = render(toolMessage([settledCall]), {
        structuredActivityUi: true,
        activeTurnIsWorking: false,
        toolsExpanded: true
      })
      expect(textIn(tree.root)).toContain('1\u00d7')
    })

    it('keeps the bridge lane on its always-visible tool run', () => {
      const tree = render(toolMessage([settledCall]), { activeTurnIsWorking: false })
      expect(textIn(tree.root)).toContain('1×')
      expect(tree.root.findAllByType('Wrench' as never)).toHaveLength(0)
    })

    it('renders the turn status row under a user message', () => {
      const tree = render(userMessage([{ type: 'text', text: 'go' }]), {
        structuredActivityUi: true,
        turnStatus: { startedAt: Date.now(), thinking: true, workedSeconds: null }
      })
      expect(textIn(tree.root)).toContain('Thinking')
    })

    it('does not render a turn status row without one', () => {
      const tree = render(userMessage([{ type: 'text', text: 'go' }]), {
        structuredActivityUi: true
      })
      expect(textIn(tree.root)).toEqual(['go'])
    })
  })
})
