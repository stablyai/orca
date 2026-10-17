vi.mock('../layout/side-safe-area', () => ({
  useWindowSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalStatusItem,
  AgentJournalToolCallItem
} from '../../../src/shared/agent-session-journal-types'
import { MAX_TOOL_DETAIL_LENGTH } from '../../../src/shared/native-chat-tool-summary'
import { projectStructuredItemToNativeChat } from '../../../src/shared/structured-agent-session-projection'
import {
  NATIVE_CHAT_INTERRUPTED_STATUS_TEXT,
  type NativeChatMessage
} from '../../../src/shared/native-chat-types'
import { AGENT_SESSION_HOST_STATUS_COPY } from '../../../src/shared/agent-session-host-status-rows'
import {
  agentSessionFailureFact,
  readProviderRetry
} from '../../../src/shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../src/shared/agent-session-failure-words'
import { structuredQuestionTranscript } from '../../../src/shared/structured-agent-question-projection'
import type { NativeChatResolvedPrompt } from '../../../src/shared/native-chat-resolution-receipt'
import { colors, typography } from '../theme/mobile-theme'
import { ANSWERED_PROMPT_ITEMS } from './mobile-native-chat-answered-prompts.test-fixture'
import { styles } from './mobile-native-chat-message-styles'

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
  AlertCircle: 'AlertCircle',
  MessageSquareMore: 'MessageSquareMore',
  AlertTriangle: 'AlertTriangle',
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
      unsentNotice?: string
      receipt?: NativeChatResolvedPrompt
      userMessageOpen?: boolean
      onToggleUserMessage?: (messageId: string) => void
      awaiting?: boolean
    } = {}
  ): ReactTestRenderer {
    act(() => {
      renderer = create(createElement(MobileNativeChatMessage, { message, ...props }))
    })
    return renderer!
  }

  const markdownIn = (node: ReactTestInstance): string[] =>
    node
      .findAll((child) => String(child.type) === 'MobileMarkdown')
      .map((markdown) => markdown.props.content)
  const textIn = (node: ReactTestInstance): string[] =>
    node.findAllByType('Text' as never).map((text) => String(text.children.join('')))

  it('renders the shared clear boundary as one muted divider with prior history retained', () => {
    const message = projectStructuredItemToNativeChat({
      itemId: 'clear',
      revision: 1,
      sequence: 5,
      observedAt: 5,
      body: {
        kind: 'status',
        text: 'Context cleared',
        presentation: 'context-cleared',
        contextClear: { operationId: 'clear', afterFence: 3, clearedAt: 5 }
      }
    })!
    const tree = render(message)
    expect(textIn(tree.root)).toEqual(['Context cleared'])
    expect(tree.root.findAll((node) => String(node.type) === 'MobileMarkdown')).toHaveLength(0)
    expect(
      tree.root.findAll(
        (node) =>
          String(node.type) === 'View' && node.props.accessibilityLabel === 'Context cleared'
      )
    ).toHaveLength(1)
  })

  const words = (node: ReactTestInstance): string[] =>
    node.children.flatMap((child) => (typeof child === 'string' ? [child] : words(child)))

  it('draws an answered approval and question as their receipts', () => {
    const { messages, receipts } = structuredQuestionTranscript(ANSWERED_PROMPT_ITEMS)
    const drawn = messages.flatMap((message) => {
      const receipt = receipts.get(message.id)
      return receipt ? [words(render(message, { receipt }).root).join('')] : []
    })
    // Each ends with when it was answered, in the device's own clock.
    expect(drawn).toEqual([
      expect.stringMatching(
        /^Bash\{[\s\S]*echo receipt-check[\s\S]*\}AllowResolved · Answered on desktop-renderer\d{1,2}:\d{2}(\s[AP]M)?$/
      ),
      expect.stringMatching(
        /^Asked: Do you prefer tea or coffee\?CoffeeResolved · Answered on desktop-renderer\d{1,2}:\d{2}(\s[AP]M)?$/
      )
    ])
  })

  it('zooms a receipt with the chat, as its words were before it became a receipt', () => {
    const { messages, receipts } = structuredQuestionTranscript(ANSWERED_PROMPT_ITEMS)
    const question = messages.find((message) => receipts.get(message.id)?.kind === 'question')!
    const tree = render(question, { receipt: receipts.get(question.id), fontScale: 1.5 })
    const sizeOf = (first: string) =>
      Object.assign(
        {},
        ...[
          tree.root.find((node) => String(node.type) === 'Text' && node.children[0] === first).props
            .style
        ].flat()
      ).fontSize
    expect(sizeOf('Asked:')).toBe(typography.bodySize * 1.5)
    expect(sizeOf('Coffee')).toBe(typography.metaSize * 1.5)
    expect(tree.root.find((node) => String(node.type) === 'MessageSquareMore').props.size).toBe(
      15 * 1.5
    )
    const time = tree.root.find(
      (node) => String(node.type) === 'Text' && node.props.accessibilityLabel
    )
    expect(Object.assign({}, ...[time.props.style].flat()).fontSize).toBe(typography.metaSize * 1.5)
  })

  it("lists a group's questions once nobody can answer them here, as desktop does", () => {
    const group = (state: 'pending' | 'cancelled'): NativeChatResolvedPrompt => ({
      kind: 'question',
      question: '2 grouped questions from Claude',
      options: [],
      questions: [
        { id: 'q1', question: 'Which targets?', multiSelect: true, options: [] },
        { id: 'q2', question: 'Proceed?', multiSelect: false, options: [] }
      ],
      resolution: { state, selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    })
    const row: NativeChatMessage = {
      id: 'grouped',
      role: 'system',
      blocks: [{ type: 'text', text: '2 grouped questions from Claude' }],
      timestamp: 1,
      source: 'transcript'
    }
    expect(words(render(row, { receipt: group('cancelled') }).root).join('')).toBe(
      'Asked: 2 questions1. Which targets?2. Proceed?Cancelled'
    )
    expect(words(render(row, { receipt: group('pending'), awaiting: false }).root).join('')).toBe(
      'Asked: 2 questions1. Which targets?2. Proceed?'
    )
    // While the host waits, the answer card shows them.
    expect(words(render(row, { receipt: group('pending') }).root).join('')).toBe(
      'Awaiting user input: 2 questions'
    )
  })

  it('draws a pending question the host no longer waits on as asked, as desktop does', () => {
    // The same journal, with the agent ended before the question was answered.
    const { messages, receipts } = structuredQuestionTranscript(
      ANSWERED_PROMPT_ITEMS.map((item) =>
        item.body.kind === 'question'
          ? {
              ...item,
              body: {
                ...item.body,
                resolution: {
                  state: 'pending',
                  selectedOptionId: null,
                  resolvedBy: null,
                  resolvedAt: null
                }
              }
            }
          : item
      )
    )
    const row = messages.find((message) => receipts.get(message.id)?.kind === 'question')!
    const receipt = receipts.get(row.id)
    expect(words(render(row, { receipt }).root).join('')).toBe(
      'Awaiting user input: Do you prefer tea or coffee?'
    )
    expect(words(render(row, { receipt, awaiting: false }).root).join('')).toBe(
      'Asked: Do you prefer tea or coffee?'
    )
  })

  it('shows when your message and the reply were written, beside copy, zoomed with the chat, as desktop does', () => {
    const at = new Date(2026, 9, 15, 15, 42).getTime()
    const timeIn = (message: NativeChatMessage) =>
      render(message, { fontScale: 1.5 })
        .root.findAll((node) => String(node.type) === 'Text' && node.props.accessibilityLabel)
        .map((node) => [
          node.children.join(''),
          Object.assign({}, ...[node.props.style].flat()).fontSize
        ])
    const shown = [[expect.stringMatching(/^(3:42\sPM|15:42)$/), typography.metaSize * 1.5]]
    expect(timeIn({ ...userMessage([{ type: 'text', text: 'ship it' }]), timestamp: at })).toEqual(
      shown
    )
    expect(timeIn({ ...toolMessage([{ type: 'text', text: 'Shipped.' }]), timestamp: at })).toEqual(
      shown
    )
    expect(timeIn(userMessage([{ type: 'text', text: 'ship it' }]))).toEqual([])
  })

  it('draws a question call as the question awaited, then as asked, never as a raw tool line', () => {
    // A Claude terminal chat's AskUserQuestion call and its answer, as the host decoded them.
    const ask = {
      type: 'tool-call' as const,
      name: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'Do you prefer red or blue?',
            header: 'Color',
            multiSelect: false,
            options: [
              { label: 'Red', description: 'You prefer red.' },
              { label: 'Blue', description: 'You prefer blue.' }
            ]
          }
        ]
      },
      callId: 'toolu_01D2nEEE5zhVRVmAvtmLBz5T'
    }
    const call = toolMessage([ask])
    const answer = {
      type: 'tool-result' as const,
      output:
        'Your questions have been answered: "Do you prefer red or blue?"="Blue". You can now continue with these answers in mind.',
      callId: 'toolu_01D2nEEE5zhVRVmAvtmLBz5T'
    }
    expect(words(render(call).root).join('')).toBe(
      'Awaiting user input: Do you prefer red or blue?'
    )
    expect(words(render({ ...call, blocks: [...call.blocks, answer] }).root).join('')).toBe(
      'Asked: Do you prefer red or blue?'
    )
    // A native chat asks desktop's selector.
    const live = { structuredActivityUi: true, activeTurnIsWorking: true }
    expect(words(render(toolMessage([{ ...ask, state: 'running' }]), live).root).join('')).toBe(
      'Awaiting user input: Do you prefer red or blue?'
    )
    expect(words(render(toolMessage([{ ...ask, state: 'completed' }]), live).root).join('')).toBe(
      'Asked: Do you prefer red or blue?'
    )
  })

  // Each row as its host writes it: Claude's API retry and sign-in rows use these shared words.
  const statusRow = (body: AgentJournalStatusItem): NativeChatMessage =>
    projectStructuredItemToNativeChat({
      itemId: 'status',
      revision: 1,
      sequence: 2,
      observedAt: 2,
      body
    })!
  it.each([
    [
      'an API retry as a warning',
      statusRow({
        kind: 'status',
        tone: 'warning',
        ...agentSessionFailureWords(
          agentSessionFailureFact('providerRetrying', {
            retry: readProviderRetry({
              error: 'overloaded',
              status: 529,
              attempt: 2,
              maxRetries: 10
            })
          }),
          { surface: 'row', agentName: 'Claude' }
        )
      }),
      colors.statusAmber
    ],
    [
      'a sign-in failure as an error',
      statusRow({
        kind: 'status',
        tone: 'error',
        ...agentSessionFailureWords(agentSessionFailureFact('notSignedIn'), {
          agentName: 'Claude',
          provider: 'claude',
          surface: 'row'
        })
      }),
      colors.statusRed
    ],
    [
      'an interruption as a faint aside',
      {
        id: 'interrupted',
        role: 'system',
        blocks: [{ type: 'text', text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT }],
        timestamp: 1,
        source: 'transcript'
      } satisfies NativeChatMessage,
      colors.textMuted
    ]
  ])('draws %s, never as the agent speaking', (_, message, color) => {
    const tree = render(message)
    expect(tree.root.findAll((node) => String(node.type) === 'MobileMarkdown')).toHaveLength(0)
    const text = tree.root.find(
      (node) => String(node.type) === 'Text' && node.props.selectable === true
    )
    expect(text.props.children).toBe(message.blocks.find((block) => block.type === 'text')?.text)
    expect(Object.assign({}, ...text.props.style)).toMatchObject({ color })
  })

  it('draws a compaction as a divider, not as a reply', () => {
    const tree = render(
      statusRow({ kind: 'status', text: 'Context compacted', presentation: 'compaction' })
    )
    expect(tree.root.findAll((node) => String(node.type) === 'MobileMarkdown')).toHaveLength(0)
    expect(
      tree.root.findAll(
        (node) =>
          String(node.type) === 'View' && node.props.accessibilityLabel === 'Context compacted'
      )
    ).toHaveLength(1)
  })

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
      const text = tree.root.find(
        (node) => String(node.type) === 'Text' && node.props.selectable === true
      )
      expect(text.props.children).toBe(AGENT_SESSION_HOST_STATUS_COPY['history-item-too-large'])
      expect(text.props.selectable).toBe(true)
      // Zoomed 1.5× with its leading zoomed too, so wrapped lines never overlap.
      expect(Object.assign({}, ...text.props.style)).toMatchObject({
        color: colors.textMuted,
        fontSize: 25.5,
        lineHeight: 34.5
      })
    }
  )

  it("names another agent's message and sets it apart from the person's bubble", () => {
    const agentMessage: NativeChatMessage = {
      ...userMessage([{ type: 'text', text: 'You have 1 orchestration message.' }]),
      from: {
        kind: 'agent',
        senders: [
          {
            party: { address: 'term_a', terminalHandle: 'term_a', orcaSessionId: null },
            name: 'Coder'
          }
        ],
        orchestration: null
      }
    }
    const tree = render(agentMessage)
    expect(textIn(tree.root)[0]).toBe('Message from Coder')
    // Left-aligned agent prose, not the person's inverted bubble.
    expect(tree.root.findAll((node) => String(node.type) === 'MobileMarkdown')).toHaveLength(1)
    const rows = tree.root.findAll(
      (node) => String(node.type) === 'View' && Array.isArray(node.props.style)
    )
    expect(rows.some((row) => row.props.style.includes(styles.rowUser))).toBe(false)
  })

  describe('a message the host recorded and did not deliver', () => {
    const notSent = { ...userMessage([{ type: 'text', text: 'fix it' }]), unsent: true as const }
    const lineIn = (tree: ReactTestRenderer) =>
      tree.root.findAll(
        (node) => String(node.type) === 'Text' && node.props.style === styles.unsentNotice
      )

    it('says why under the bubble, and draws no line without a reason, as the desktop', () => {
      const tree = render(notSent, { unsentNotice: 'Claude is not signed in.' })
      expect(markdownIn(tree.root)).toEqual(['fix it'])
      expect(textIn(tree.root)).toEqual(['Claude is not signed in.'])
      expect(lineIn(render(notSent))).toHaveLength(0)
    })

    it("draws the line under another agent's message too", () => {
      const fromAgent: NativeChatMessage = {
        ...notSent,
        from: {
          kind: 'agent',
          senders: [
            {
              party: { address: 'term_a', terminalHandle: 'term_a', orcaSessionId: null },
              name: 'Coder'
            }
          ],
          orchestration: null
        }
      }
      expect(
        lineIn(render(fromAgent, { unsentNotice: 'Your message was not sent.' }))
      ).toHaveLength(1)
    })
  })

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
    expect(
      tree.root.findByProps({ accessibilityLabel: 'Open image 1 of 1' }).props.accessibilityRole
    ).toBe('button')
  })

  it('draws a picture-only message without an empty text bubble', () => {
    render(userMessage([{ type: 'image-ref', url: 'file:///a.jpg', alt: 'a photo' }]))
    expect(
      renderer!.root.findAll(
        (node) =>
          String(node.type) === 'View' && [node.props.style].flat().includes(styles.userBubble)
      )
    ).toHaveLength(0)
  })

  it('folds a long message of yours until opened, and the transcript keeps it open', () => {
    const long = Array.from({ length: 12 }, (_, line) => `line ${line + 1}`).join('\n')
    const message = userMessage([{ type: 'text', text: long }])
    const onToggleUserMessage = vi.fn()
    const clips = (tree: ReactTestRenderer) =>
      tree.root.findAll(
        (node) => String(node.type) === 'View' && node.props.style?.overflow === 'hidden'
      )
    const folded = render(message, { onToggleUserMessage })
    expect(clips(folded)).toHaveLength(1)
    // Native layout fits the cut text to the clip, so it measures at the fold: it stays folded and
    // offers the rest, rather than unfolding to measure taller and folding again.
    act(() =>
      clips(folded)[0]!
        .find((node) => node.props.onLayout !== undefined)
        .props.onLayout({ nativeEvent: { layout: { height: 190 } } })
    )
    expect(clips(folded)).toHaveLength(1)
    act(() =>
      folded.root
        .find(
          (node) => String(node.type) === 'Pressable' && textIn(node).includes('Show full message')
        )
        .props.onPress()
    )
    expect(onToggleUserMessage).toHaveBeenCalledWith('u1')
    // The list recycles rows; the transcript's state draws it open again.
    expect(clips(render(message, { userMessageOpen: true, onToggleUserMessage }))).toHaveLength(0)
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

  it('draws your message as selectable Markdown in the bubble’s dark-on-light colours', () => {
    const tree = render(userMessage([{ type: 'text', text: '**Fix** `src/a.ts`' }]))
    const markdown = tree.root.findByType('MobileMarkdown' as never)
    expect(markdown.props).toMatchObject({
      content: '**Fix** `src/a.ts`',
      tone: 'onBright',
      rangeSelectable: true
    })
    expect(markdown.props.renderVisual).toBeUndefined()
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
      expect(markdownIn(tree.root)).toEqual(['go'])
      expect(textIn(tree.root)).toEqual([])
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
