import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalToolCallItem } from '../../../src/shared/agent-session-journal-types'
import { MAX_TOOL_DETAIL_LENGTH } from '../../../src/shared/native-chat-tool-summary'
import { projectStructuredItemToNativeChat } from '../../../src/shared/structured-agent-session-projection'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { AGENT_SESSION_HOST_STATUS_COPY } from '../../../src/shared/agent-session-host-status-rows'
import { colors } from '../theme/mobile-theme'

vi.mock('react-native', async () => {
  const React = await import('react')
  const Text = ({ children, ...props }: { children?: unknown }): unknown =>
    React.createElement('Text', props, children)
  return {
    ActivityIndicator: 'ActivityIndicator',
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
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    ScrollView: ({ children, ...props }: { children?: unknown }) =>
      React.createElement('ScrollView', props, children),
    Text,
    View: ({ children, ...props }: { children?: unknown }) =>
      React.createElement('View', props, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
  }
})
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  Brain: 'Brain',
  ChevronDown: 'ChevronDown',
  Copy: 'Copy',
  SquareChevronRight: 'SquareChevronRight',
  SquareTerminal: 'SquareTerminal',
  Wrench: 'Wrench',
  ChevronRight: 'ChevronRight'
}))
vi.mock('../components/MobileMarkdown', () => ({ MobileMarkdown: 'MobileMarkdown' }))
vi.mock('./MobileNativeChatMessageActionsSheet', () => ({
  MobileNativeChatMessageActionsSheet: 'MessageActionsSheet'
}))

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
      fontScale?: number
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
      reasoningIsLive?: boolean
    } = {}
  ): ReactTestRenderer {
    act(() => {
      renderer = create(createElement(MobileNativeChatMessage, { message, ...props }))
    })
    return renderer!
  }

  const textIn = (node: ReactTestInstance): string[] =>
    node.findAllByType('Text' as never).map((text) => String(text.children.join('')))

  it.each(['system', 'user'] as const)(
    'renders a %s host notice as selectable muted text rather than a markdown answer',
    (role) => {
      const tree = render(
        {
          id: 'notice',
          role,
          timestamp: 1,
          blocks: [
            { type: 'text', text: 'provider fallback', presentation: 'history-item-too-large' }
          ]
        },
        { fontScale: 1.5 }
      )
      expect(tree.root.findAll((node) => String(node.type) === 'MobileMarkdown')).toHaveLength(0)
      const text = tree.root.find((node) => String(node.type) === 'Text')
      expect(text.props.children).toBe(AGENT_SESSION_HOST_STATUS_COPY['history-item-too-large'])
      expect(text.props.selectable).toBe(true)
      expect(Object.assign({}, ...text.props.style)).toMatchObject({
        color: colors.textMuted,
        fontSize: 25.5
      })
    }
  )

  it('preserves an ordinary assistant answer without interpreting its text as a host notice', () => {
    const tree = render(toolMessage([{ type: 'text', text: 'provider fallback' }]))
    expect(tree.root.find((node) => String(node.type) === 'MobileMarkdown').props.content).toBe(
      'provider fallback'
    )
  })

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

  it('makes user message text selectable', () => {
    const tree = render(userMessage([{ type: 'text', text: 'Prompt I typed' }]))
    const text = tree.root
      .findAllByType('Text' as never)
      .find((node) => String(node.children.join('')) === 'Prompt I typed')
    expect(text?.props.selectable).toBe(true)
  })

  it('routes assistant prose through selectable Markdown', () => {
    const tree = render(toolMessage([{ type: 'text', text: 'Agent reply prose' }]))
    const markdown = tree.root.findByType('MobileMarkdown' as never)
    expect(markdown.props.content).toBe('Agent reply prose')
    expect(markdown.props.rangeSelectable).toBe(true)
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

  describe('output a call left when it ended early', () => {
    function projectedCall(ending: Pick<AgentJournalToolCallItem, 'endedAs'>): NativeChatMessage {
      const body: AgentJournalToolCallItem = {
        kind: 'tool-call',
        name: 'shell',
        input: { command: 'sleep 20' },
        state: 'failed',
        ...ending,
        output: { head: 'partial', byteLength: 7, digest: 'd', truncated: false }
      }
      const projected = projectStructuredItemToNativeChat({
        itemId: 'call',
        sequence: 1,
        revision: 1,
        observedAt: 100,
        body
      })
      if (!projected) {
        throw new Error('the call projects no message')
      }
      return { ...projected, id: 'a1', source: 'transcript' }
    }
    const outputStyle = (message: NativeChatMessage): unknown => {
      const tree = render(message, { toolsExpanded: true })
      const output = tree.root
        .findAllByType('Text' as never)
        .find((node) => node.children.join('') === 'partial')
      // The tint is on the result box: the nearest View around the output text.
      let box = output?.parent ?? null
      while (box && String(box.type) !== 'View') {
        box = box.parent
      }
      return box?.props.style
    }

    it('shows the output a stop cut short without the error tint', () => {
      expect(outputStyle(projectedCall({ endedAs: 'interrupted' }))).toEqual([
        expect.any(Object),
        false
      ])
    })

    it('keeps the error tint on a call nothing proved was cut short', () => {
      expect(outputStyle(projectedCall({ endedAs: 'unverifiable' }))).toEqual([
        expect.any(Object),
        expect.objectContaining({ backgroundColor: expect.any(String) })
      ])
    })
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

    it('renders the settled turn status row under a user message', () => {
      const tree = render(userMessage([{ type: 'text', text: 'go' }]), {
        structuredActivityUi: true,
        turnStatus: { startedAt: Date.now() - 3_000, thinking: false, workedSeconds: 3 }
      })
      expect(textIn(tree.root)).toContain('Worked for 3s')
    })

    it('does not render a turn status row without one', () => {
      const tree = render(userMessage([{ type: 'text', text: 'go' }]), {
        structuredActivityUi: true
      })
      expect(textIn(tree.root)).toEqual(['go'])
    })
  })

  describe('a reasoning row', () => {
    const reasoning = (fields: Partial<NativeChatMessage> = {}): NativeChatMessage => ({
      id: 'r1',
      role: 'reasoning',
      blocks: [{ type: 'text', text: 'Weighing two approaches' }],
      timestamp: 1_000,
      source: 'transcript',
      state: 'completed',
      completedAt: 4_000,
      ...fields
    })
    const toggleOf = (tree: ReactTestRenderer): ReactTestInstance =>
      tree.root.find(
        (node) => String(node.type) === 'Pressable' && node.props.accessibilityRole === 'button'
      )
    const markdownIn = (tree: ReactTestRenderer): ReactTestInstance[] =>
      tree.root.findAll((node) => String(node.type) === 'MobileMarkdown')

    it('starts collapsed to its headline, with its text unmounted', () => {
      const tree = render(reasoning())
      expect(textIn(tree.root)).toContain('Thought for 3s')
      expect(toggleOf(tree).props.accessibilityState).toEqual({ expanded: false })
      // Said with what it is, as desktop's screen-reader prefix does, on a 32 + 2 × 6 pt target.
      expect(toggleOf(tree).props.accessibilityLabel).toBe('Reasoning: Thought for 3s')
      expect(toggleOf(tree).props.hitSlop).toBe(6)
      expect(markdownIn(tree)).toHaveLength(0)
    })

    it('leads its headline with the brain, as desktop does', () => {
      const [first] = toggleOf(render(reasoning())).children
      expect(typeof first === 'string' ? first : first?.type).toBe('Brain')
    })

    it('mounts its text once opened', () => {
      const tree = render(reasoning())
      act(() => toggleOf(tree).props.onPress())
      expect(toggleOf(tree).props.accessibilityState).toEqual({ expanded: true })
      expect(markdownIn(tree).map((node) => node.props.content)).toEqual([
        'Weighing two approaches'
      ])
    })

    it('draws nothing while the live line discloses it, or when blank', () => {
      expect(
        render(reasoning({ state: 'running' }), {
          activeTurnIsWorking: true,
          reasoningIsLive: true
        }).toJSON()
      ).toBeNull()
      expect(render(reasoning({ blocks: [{ type: 'text', text: ' \n ' }] })).toJSON()).toBeNull()
    })

    // The turn's bar is not the block's: hiding the block must not hide the bar it sits on.
    it("still draws its turn's bar while the live line discloses it", () => {
      const tree = render(reasoning({ state: 'running' }), {
        activeTurnIsWorking: true,
        reasoningIsLive: true,
        turnStatus: { startedAt: 1_000, thinking: true, workedSeconds: null }
      })
      expect(tree.root.findAll((node) => String(node.type) === 'Pressable')).toHaveLength(0)
      expect(textIn(tree.root).some((text) => text.startsWith('Working for'))).toBe(true)
    })

    // Only the block the line discloses hides: a subagent's or a stale open block draws, unended.
    it('draws any other open block in its working turn as Reasoning', () => {
      const child = render(reasoning({ state: 'running', agentId: 'sub-1' }), {
        activeTurnIsWorking: true
      })
      expect(textIn(child.root)).toContain('Reasoning')
      expect(toggleOf(child).props.accessibilityLabel).toBe('Reasoning')
    })

    it('says only what the host saw', () => {
      expect(textIn(render(reasoning({ state: 'running' })).root)).toContain('Thought')
      const unknown = render(reasoning({ state: undefined, completedAt: undefined }))
      expect(textIn(unknown.root)).toContain('Reasoning')
      // No "Reasoning: Reasoning".
      expect(toggleOf(unknown).props.accessibilityLabel).toBe('Reasoning')
      expect(textIn(render(reasoning({ completedAt: 1_300 })).root)).toContain('Thought for 1s')
    })
  })
})
