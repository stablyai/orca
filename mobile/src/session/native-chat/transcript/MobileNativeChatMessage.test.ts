import './mobile-agent-message-renderer.test-fixture'
import { stubRpcClient } from '../../../transport/rpc-client-test-stub'
import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX } from '../../../../../src/shared/orca-dispatch-status-prompt'
import { projectStructuredItemToNativeChat } from '../../../../../src/shared/structured-agent-session-projection'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat-types'
import { AGENT_SESSION_HOST_STATUS_COPY } from '../../../../../src/shared/agent-session-host-status-rows'
import { structuredQuestionTranscript } from '../../../../../src/shared/structured-agent-question-projection'
import type { NativeChatResolvedPrompt } from '../../../../../src/shared/native-chat-resolution-receipt'
import { colors, typography } from '../../../theme/mobile-theme'
import { ANSWERED_PROMPT_ITEMS } from '../input/mobile-native-chat-answered-prompts.test-fixture'
import { MobileNativeChatRowOverlaysContext } from './mobile-native-chat-row-overlays'
import { styles } from './mobile-native-chat-message-styles'
import { agentMessageTranscriptText } from '../../../../../src/shared/agent-session/agent-message-display-text'
import {
  agentMessageHeading,
  agentMessageSenderLabel
} from '../../../../../src/shared/agent-session/agent-message-presentation'
import type { AgentMessageSource } from '../../../../../src/shared/agent-session/agent-session-message-source'

import { MobileNativeChatMessage } from './MobileNativeChatMessage'
import { useMobileStructuredAgentSession } from '../../use-mobile-structured-agent-session'
import { snapshotEvent, ok } from '../../use-mobile-structured-agent-session-queued.test-fixture'
import {
  findAllByHostType,
  findByHostType
} from '../../../test-support/react-test-renderer-host-nodes'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }
}))

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

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
      structuredActivityUi?: boolean
      activeTurnIsWorking?: boolean
      trailingRun?: boolean
      foldedAway?: boolean
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
    findAllByHostType(node, 'Text').map((text) => String(text.children.join('')))

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
    expect(drawn).toEqual([
      expect.stringMatching(
        /^Bash\{[\s\S]*echo receipt-check[\s\S]*\}AllowResolved · Answered on desktop-renderer\d{1,2}:\d{2}(\s[AP]M)?$/
      ),
      expect.stringMatching(
        /^Asked: Do you prefer tea or coffee\?CoffeeResolved · Answered on desktop-renderer\d{1,2}:\d{2}(\s[AP]M)?$/
      )
    ])
  })

  it('keeps answered receipts beside Started worker through the production structured hook', async () => {
    const items = [
      {
        itemId: 'start',
        revision: 1,
        sequence: 42,
        observedAt: 1,
        body: {
          kind: 'agent-start' as const,
          dispatchId: 'dispatch',
          task: 'Worker assignment',
          worker: {
            party: { address: 'term_worker', terminalHandle: 'term_worker', orcaSessionId: null },
            name: 'Worker'
          }
        }
      },
      ...ANSWERED_PROMPT_ITEMS
    ]
    const client = stubRpcClient({
      sendRequest: async () => ok({}),
      subscribe: (method, _params, onData) => {
        if (method === 'agentSession.subscribe') {
          onData(snapshotEvent({ items }))
        }
        return () => {}
      }
    })
    const onSendError = vi.fn()
    function Transcript() {
      const structured = useMobileStructuredAgentSession({
        client,
        sessionId: 'session-1',
        agent: 'claude',
        enabled: true,
        connected: true,
        hostSupport: null,
        onSendError
      })
      return structured.session.messages.map((message) =>
        createElement(MobileNativeChatMessage, {
          key: message.id,
          message,
          receipt: structured.receipts.get(message.id)
        })
      )
    }
    await act(async () => {
      renderer = create(createElement(Transcript))
    })
    const drawn = words(renderer!.root).join('')
    expect(drawn).toContain('Started worker')
    expect(drawn).toContain(
      'Asked: Do you prefer tea or coffee?CoffeeResolved · Answered on desktop-renderer'
    )
    expect(drawn).toContain('AllowResolved · Answered on desktop-renderer')
    expect(markdownIn(renderer!.root)[0]).toBe('Worker assignment')
  })

  it("keeps an answered prompt's receipt when its settled turn folds away, as desktop does", () => {
    const { messages, receipts } = structuredQuestionTranscript(ANSWERED_PROMPT_ITEMS)
    const question = messages.find((message) => receipts.get(message.id)?.kind === 'question')!
    const tree = render(question, { receipt: receipts.get(question.id), foldedAway: true })
    expect(words(tree.root).join('')).toContain('Asked: Do you prefer tea or coffee?')
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
    expect(words(render(row, { receipt: group('pending') }).root).join('')).toBe(
      'Awaiting user input: 2 questions'
    )
  })

  it('draws a pending question the host no longer waits on as asked, as desktop does', () => {
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
    const live = { structuredActivityUi: true, activeTurnIsWorking: true }
    expect(words(render(toolMessage([{ ...ask, state: 'running' }]), live).root).join('')).toBe(
      'Awaiting user input: Do you prefer red or blue?'
    )
    expect(words(render(toolMessage([{ ...ask, state: 'completed' }]), live).root).join('')).toBe(
      'Asked: Do you prefer red or blue?'
    )
  })

  it.each([
    ['system', 'history-item-too-large'],
    ['user', 'history-item-too-large']
  ] as const)(
    'renders a %s host notice as selectable muted text rather than a markdown answer',
    (role, presentation) => {
      const tree = render(
        {
          id: 'notice',
          role,
          timestamp: 1,
          source: 'transcript',
          blocks: [{ type: 'text', text: 'provider fallback', presentation }]
        },
        { fontScale: 1.5 }
      )
      expect(tree.root.findAll((node) => String(node.type) === 'MobileMarkdown')).toHaveLength(0)
      const text = tree.root.find(
        (node) => String(node.type) === 'Text' && node.props.selectable === true
      )
      expect(text.props.children).toBe(AGENT_SESSION_HOST_STATUS_COPY[presentation])
      expect(text.props.selectable).toBe(true)
      expect(Object.assign({}, ...text.props.style)).toMatchObject({
        color: colors.textMuted,
        fontSize: 25.5,
        lineHeight: 34.5
      })
    }
  )

  it.each(['started', 'task', 'coordinator', 'worker', 'generic'] as const)(
    'uses the desktop shared heading, sender, text and fold rules for %s',
    (kind) => {
      const from: AgentMessageSource = {
        kind: 'agent',
        senders: [
          {
            party: { address: 'term_sender', terminalHandle: 'term_sender', orcaSessionId: null },
            name: 'Parser worker',
            ...(kind === 'coordinator' || kind === 'worker' ? { relation: kind } : {})
          }
        ],
        orchestration:
          kind === 'task'
            ? { message: 'task', runId: 'r', taskId: 't', dispatchId: 'd' }
            : { message: 'mail-notice', mailbox: 'term_recipient', dispatchId: null, messages: [] }
      }
      const body = 'A short task fits without a disclosure.'
      const raw =
        kind === 'task'
          ? `${ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX}\r\nInstructions\r\n=== TASK ===\r\n${body}`
          : body
      const message: NativeChatMessage = {
        ...userMessage([{ type: 'text', text: raw }]),
        from,
        ...(kind === 'started' ? ({ role: 'system', agentStart: true } as const) : {})
      }
      const tree = render(message)
      const headings = {
        started: 'Started worker',
        task: 'Task from coordinator',
        coordinator: 'Message from coordinator',
        worker: 'Update from worker',
        generic: 'Message from'
      }
      expect(textIn(tree.root).slice(0, 2)).toEqual([
        headings[agentMessageHeading(from, message.agentStart === true)],
        agentMessageSenderLabel({
          localChat: false,
          snapshotName: from.senders[0].name,
          fallback: 'an agent'
        })
      ])
      expect(markdownIn(tree.root)).toEqual([agentMessageTranscriptText(message.blocks, from)])
    }
  )

  it('finishes an agent image-only card with zero body extent and keeps its attachment', () => {
    const tree = render({
      ...userMessage([{ type: 'image-ref', url: 'file:///a.jpg', alt: 'a photo' }]),
      from: {
        kind: 'agent',
        orchestration: null,
        senders: [
          {
            name: 'Worker',
            party: { address: 'term_worker', terminalHandle: 'term_worker', orcaSessionId: null }
          }
        ]
      }
    })
    expect(tree.root.findAllByProps({ testID: 'agent-message-card' })).toHaveLength(1)
    expect(findAllByHostType(tree.root, 'Image')).toHaveLength(1)
    act(() =>
      tree.root
        .findByProps({ testID: 'agent-message-body' })
        .props.onLayout({ nativeEvent: { layout: { height: 0 } } })
    )
    expect(tree.root.findByProps({ testID: 'agent-message-viewport' }).props.style.height).toBe(0)
    expect(textIn(tree.root)).not.toContain('Show more')
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Copy message' })).toHaveLength(0)
  })

  it('measures the natural layer, expands and refolds, and preserves old-server body', () => {
    const from: AgentMessageSource = { kind: 'agent', orchestration: null, senders: [] }
    const message = {
      ...userMessage([
        { type: 'text' as const, text: 'Long paragraph wrapped over many native lines.' }
      ]),
      from
    }
    const tree = render(message)
    const measured = tree.root.findByProps({ testID: 'agent-message-body' })
    const clip = tree.root.findByProps({ testID: 'agent-message-viewport' })
    const folded = clip.props.style.height
    expect(measured.props.style).toMatchObject({ position: 'absolute', left: 0, right: 0, top: 0 })
    act(() => measured.props.onLayout({ nativeEvent: { layout: { height: folded } } }))
    expect(textIn(tree.root)).not.toContain('Show more')
    act(() => measured.props.onLayout({ nativeEvent: { layout: { height: folded * 4 } } }))
    const toggle = () =>
      findAllByHostType(tree.root, 'Pressable').find(
        (node) => node.props.accessibilityState?.expanded !== undefined
      )!
    act(() => toggle().props.onPress())
    expect(clip.props.style.height).toBe(folded * 4)
    act(() => toggle().props.onPress())
    expect(clip.props.style.height).toBe(folded)
    expect(textIn(tree.root)).toContain('Show more')
    const body = () => tree.root.findByProps({ testID: 'agent-message-body' })
    const viewport = () => tree.root.findByProps({ testID: 'agent-message-viewport' })
    let stale = body().props.onLayout
    act(() => viewport().props.onLayout({ nativeEvent: { layout: { width: 320 } } }))
    act(() => stale({ nativeEvent: { layout: { height: 900 } } }))
    expect(viewport().props.style.height).toBe(folded)
    expect(textIn(tree.root)).not.toContain('Show more')
    act(() => body().props.onLayout({ nativeEvent: { layout: { height: folded * 2 } } }))
    expect(textIn(tree.root)).toContain('Show more')
    stale = body().props.onLayout
    act(() => tree.update(createElement(MobileNativeChatMessage, { message, fontScale: 1.5 })))
    act(() => stale({ nativeEvent: { layout: { height: 900 } } }))
    expect(viewport().props.style.height).toBe(folded * 1.5)
    act(() => body().props.onLayout({ nativeEvent: { layout: { height: 10 } } }))
    expect(viewport().props.style.height).toBe(10)
    stale = body().props.onLayout
    const recovered = {
      ...message,
      blocks: [{ type: 'text' as const, text: 'Recovered current body' }]
    }
    act(() =>
      tree.update(createElement(MobileNativeChatMessage, { message: recovered, fontScale: 1.5 }))
    )
    act(() => stale({ nativeEvent: { layout: { height: 900 } } }))
    expect(viewport().props.style.height).toBe(folded * 1.5)
    act(() => body().props.onLayout({ nativeEvent: { layout: { height: 20 } } }))
    expect(viewport().props.style.height).toBe(20)
    expect(markdownIn(tree.root)).toEqual(['Recovered current body'])
    act(() => tree.unmount())
    const oldServer = render({ ...message, from: undefined })
    expect(oldServer.root.findAllByProps({ testID: 'agent-message-card' })).toHaveLength(0)
    expect(markdownIn(oldServer.root)).toEqual([
      message.blocks[0].type === 'text' ? message.blocks[0].text : ''
    ])
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
    const image = findByHostType(tree.root, 'Image')
    expect(image.props.source).toEqual({ uri: 'file:///a.jpg' })
    expect(image.parent?.props).toMatchObject({
      accessibilityRole: 'imagebutton',
      accessibilityLabel: 'a photo'
    })
  })

  it('opens an attachment full size when tapped', () => {
    const openImage = vi.fn()
    act(() => {
      renderer = create(
        createElement(
          MobileNativeChatRowOverlaysContext.Provider,
          { value: { openImage, openActions: vi.fn() } },
          createElement(MobileNativeChatMessage, {
            message: userMessage([{ type: 'image-ref', url: 'file:///a.jpg', alt: 'a photo' }])
          })
        )
      )
    })
    act(() => renderer!.root.findByProps({ accessibilityRole: 'imagebutton' }).props.onPress())
    expect(openImage).toHaveBeenCalledWith({ uri: 'file:///a.jpg', label: 'a photo' })
  })

  it('draws a picture-only message with nothing else in its bubble, so no gap sits under it', () => {
    render(userMessage([{ type: 'image-ref', url: 'file:///a.jpg', alt: 'a photo' }]))
    const bubble = renderer!.root.find(
      (node) =>
        String(node.type) === 'View' && [node.props.style].flat().includes(styles.userBubble)
    )
    expect(bubble.findAll((node) => node !== bubble && String(node.type) === 'View')).toHaveLength(
      0
    )
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
    // Native clips measure at their folded height; expanding to test greater-than would cause a fold/unfold loop.
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
    expect(clips(render(message, { userMessageOpen: true, onToggleUserMessage }))).toHaveLength(0)
  })

  it('prefers the url over the path when both are present', () => {
    const tree = render(
      userMessage([{ type: 'image-ref', url: 'file:///local.jpg', path: '/tmp/host.png' }])
    )
    expect(findByHostType(tree.root, 'Image').props.source).toEqual({
      uri: 'file:///local.jpg'
    })
  })

  it('falls back to a text placeholder for a bare host path', () => {
    // Host paths, including SSH paths, cannot be loaded directly on this device.
    const tree = render(userMessage([{ type: 'image-ref', path: '/tmp/host.png' }]))
    expect(findAllByHostType(tree.root, 'Image')).toHaveLength(0)
    const texts = findAllByHostType(tree.root, 'Text').map((node) => String(node.children.join('')))
    expect(texts.some((text) => text.includes('/tmp/host.png'))).toBe(true)
  })

  // An older host refuses the read; the row keeps today's placeholder.
  const STORED = '/home/me/.orca/agent-session-attachments/6f1c2a4e/shot.png'
  const GENERATED = '/home/me/.codex/generated_images/shot.png'
  const IMAGE = {
    ok: true,
    result: { content: PNG, isBinary: true, isImage: true, mimeType: 'image/png' }
  } as const
  const REFUSED = {
    ok: false,
    error: { code: 'method_not_found', message: 'unknown method' }
  } as const
  it.each([
    [
      STORED,
      'agentSessionAttachment.read',
      { path: STORED },
      IMAGE,
      [`data:image/png;base64,${PNG}`]
    ],
    [STORED, 'agentSessionAttachment.read', { path: STORED }, REFUSED, []],
    [
      GENERATED,
      'files.readChatImage',
      { worktree: 'id:wt-1', path: GENERATED },
      IMAGE,
      [`data:image/png;base64,${PNG}`]
    ],
    [GENERATED, 'files.readChatImage', { worktree: 'id:wt-1', path: GENERATED }, REFUSED, []]
  ] as const)(
    'reads %s from the chat host with %s',
    async (path, method, params, reply, thumbnails) => {
      const sendRequest = vi.fn(async () => ({ id: '1', ...reply }))
      await act(async () => {
        renderer = create(
          createElement(
            MobileNativeChatRowOverlaysContext.Provider,
            {
              value: {
                openImage: vi.fn(),
                openActions: vi.fn(),
                imageSource: { client: stubRpcClient({ sendRequest }), worktreeId: 'wt-1' }
              }
            },
            createElement(MobileNativeChatMessage, {
              message: userMessage([{ type: 'image-ref', path, alt: 'shot' }])
            })
          )
        )
      })
      expect(sendRequest).toHaveBeenCalledWith(method, params, expect.anything())
      expect(
        findAllByHostType(renderer!.root, 'Image').map((image) => image.props.source.uri)
      ).toEqual(thumbnails)
    }
  )

  it('draws your message as selectable Markdown in the bubble’s text colour', () => {
    const tree = render(userMessage([{ type: 'text', text: '**Fix** `src/a.ts`' }]))
    const markdown = findByHostType(tree.root, 'MobileMarkdown')
    expect(markdown.props).toMatchObject({
      content: '**Fix** `src/a.ts`',
      tone: 'userMessage',
      rangeSelectable: true
    })
    expect(markdown.props.renderVisual).toBeUndefined()
  })

  it('routes assistant prose through selectable Markdown', () => {
    const tree = render(toolMessage([{ type: 'text', text: 'Agent reply prose' }]))
    const markdown = findByHostType(tree.root, 'MobileMarkdown')
    expect(markdown.props.content).toBe('Agent reply prose')
    expect(markdown.props.rangeSelectable).toBe(true)
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

    it('keeps one live header while calls start and finish, naming the latest call beside it', () => {
      const tree = render(toolMessage([runningCall]), {
        structuredActivityUi: true,
        activeTurnIsWorking: true
      })
      expect(textIn(tree.root)).toEqual(expect.arrayContaining(['Running 1 command', 'npm test']))
      expect(findAllByHostType(tree.root, 'SquareTerminal')).toHaveLength(1)
      act(() =>
        tree.update(
          createElement(MobileNativeChatMessage, {
            message: toolMessage([
              { ...runningCall, state: 'completed' },
              { type: 'tool-call', name: 'Diff', input: { path: 'src/a.ts' } }
            ]),
            structuredActivityUi: true,
            activeTurnIsWorking: true
          })
        )
      )
      expect(textIn(tree.root)).toEqual(
        expect.arrayContaining(['Running 1 command and editing 1 file', 'Diff src/a.ts'])
      )
      expect(textIn(tree.root).some((text) => text.startsWith('Running Diff'))).toBe(false)
    })

    it('settles to the past tense once the agent moves past the run', () => {
      const tree = render(toolMessage([settledCall, runningCall]), {
        structuredActivityUi: true,
        activeTurnIsWorking: true,
        trailingRun: false
      })
      expect(textIn(tree.root)).toContain('Read 1 file and ran 1 command')
    })

    it('draws nothing for a row its settled turn folded away', () => {
      const folded = render(toolMessage([settledCall]), {
        structuredActivityUi: true,
        activeTurnIsWorking: false,
        foldedAway: true
      })
      expect(textIn(folded.root)).toEqual([])
    })

    it("keeps a settled turn's answer row whole, its own run included", () => {
      const tree = render(toolMessage([{ type: 'text', text: 'Done.' }, settledCall]), {
        structuredActivityUi: true,
        activeTurnIsWorking: false
      })
      expect(textIn(tree.root)).toContain('Read 1 file')
    })

    it('renders the settled turn status row under a user message', () => {
      const tree = render(userMessage([{ type: 'text', text: 'go' }]), {
        structuredActivityUi: true,
        turnStatus: { startedAt: 1_700_000_000_000, thinking: false, workedSeconds: 3 }
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
})
