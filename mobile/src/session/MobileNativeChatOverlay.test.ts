import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatAsyncQuestionsView } from '../../../src/shared/native-chat-async-questions'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileNativeChatOverlay } from './MobileNativeChatOverlay'
import type { MobileNativeChatController } from './use-mobile-native-chat-controller'

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles, absoluteFillObject: {} },
  View: 'View'
}))

vi.mock('./MobileNativeChatView', () => ({ MobileNativeChatView: 'ChatView' }))
vi.mock('./MobileNativeChatQueuedMessages', () => ({ MobileNativeChatQueuedMessages: 'Queued' }))
vi.mock('./MobileNativeChatAsyncQuestions', () => ({
  MobileNativeChatAsyncQuestions: 'AsyncQuestions'
}))

function assistantTurn(id: string, text: string): NativeChatMessage {
  return { id, role: 'assistant', blocks: [{ type: 'text', text }], timestamp: 0, source: 'hook' }
}

/** One render of the route: chat visible or not, the transcript it currently
 *  holds, and the agent-status stream behind it. */
type Tick = {
  show?: boolean
  messages?: NativeChatMessage[]
  streamingText?: string
  streamLive?: boolean
  identity?: string
  blocking?: 'nativeChatAsk' | 'nativeChatPermission' | 'nativeChatQuestion'
  asyncQuestions?: NativeChatAsyncQuestionsView
}

const asyncQuestionsModel = { open: [{ key: 'q-a', index: 0, title: 'Which name?' }] }

function overlayElement(tick: Tick): ReturnType<typeof createElement> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the overlay reads only these controller members; the rest of the controller is unreachable from it.
  const controller = {
    showNativeChat: tick.show ?? true,
    nativeChatSession: {
      messages: tick.messages ?? [],
      status: 'ready',
      asyncQuestions: tick.asyncQuestions ?? { state: 'absent' }
    },
    nativeChatAgent: 'claude',
    nativeChatAgentWorking: tick.streamLive ?? false,
    nativeChatStreamingText: tick.streamingText,
    nativeChatStreamLive: tick.streamLive ?? false,
    nativeChatStreamScopeKey: tick.identity ?? 'tab-a',
    chatPending: [],
    chatImagePreviewsByMessageId: {},
    chatComposerText: '',
    setChatComposerText: vi.fn(),
    nativeChatQueued: {
      cards: [],
      send: vi.fn(),
      delete: vi.fn(),
      edit: vi.fn(),
      pause: null,
      resume: vi.fn(),
      sessionKey: 'session-a'
    },
    nativeChatAsyncQuestions: asyncQuestionsModel,
    ...(tick.blocking ? { [tick.blocking]: { id: 'blocking' } } : {})
  } as unknown as MobileNativeChatController
  return createElement(MobileNativeChatOverlay, {
    controller,
    images: {} as never,
    onMicPress: vi.fn(),
    micActive: false,
    dictationMode: 'toggle',
    onMicPressIn: vi.fn(),
    onMicPressOut: vi.fn(),
    inputLockReason: null,
    sendErrorMessage: null,
    onClearSendError: vi.fn(),
    sendSurfaceId: tick.identity ?? 'tab-a',
    getSendCompletionGeneration: () => 0,
    keyboardInset: 0
  })
}

describe('MobileNativeChatOverlay streaming gate', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  async function render(tick: Tick): Promise<void> {
    await act(async () => {
      renderer = create(overlayElement(tick))
    })
  }

  async function update(tick: Tick): Promise<void> {
    await act(async () => {
      renderer?.update(overlayElement(tick))
    })
  }

  /** The bubble text handed to the chat list, or `'hidden'` when chat is off. */
  function streaming(): string | null | 'hidden' {
    const views = renderer!.root.findAll((node) => node.type === 'ChatView')
    return views.length === 0 ? 'hidden' : (views[0].props.streaming as string | null)
  }

  it('keeps streaming a reply that repeats the previous turn as a prefix', async () => {
    const prior = [assistantTurn('a1', 'The tests pass.')]
    await render({ messages: prior })
    expect(streaming()).toBeNull()

    await update({ messages: prior, streamingText: 'The tests', streamLive: true })

    expect(streaming()).toBe('The tests')
  })

  it('drops the streaming bubble once the reply lands as its own turn', async () => {
    const prior = [assistantTurn('a1', 'Done.')]
    await render({ messages: prior })
    await update({ messages: prior, streamingText: 'Done.', streamLive: true })
    expect(streaming()).toBe('Done.')

    await update({
      messages: [...prior, assistantTurn('a2', 'Done.')],
      streamingText: 'Done.',
      streamLive: true
    })

    expect(streaming()).toBeNull()
  })

  it('keeps the bubble across a peek at the terminal view', async () => {
    // Toggling to the terminal unmounts the chat list and unsubscribes its
    // transcript. The gate lives above that boundary, so the baseline survives
    // and the repeated-prefix reply keeps streaming on the way back.
    const prior = [assistantTurn('a1', 'Done.')]
    await render({ messages: prior })
    await update({ messages: prior, streamingText: 'Done.', streamLive: true })
    expect(streaming()).toBe('Done.')

    await update({ show: false, messages: [], streamLive: true })
    expect(streaming()).toBe('hidden')
    // Back on chat the session withholds its transcript until a fresh read
    // settles, so the throttled stream text returns a round trip ahead of it.
    await update({ messages: [], streamLive: true })
    await update({ messages: [], streamingText: 'Done.', streamLive: true })
    await update({ messages: prior, streamingText: 'Done.', streamLive: true })

    expect(streaming()).toBe('Done.')
  })

  it('keeps the bubble across a peek at the terminal taken between turns', async () => {
    // Same toggle, but taken while idle: the transcript empties before the next
    // turn starts, so the gate has to reject that empty tail as a baseline.
    const prior = [assistantTurn('a1', 'Done.')]
    await render({ messages: prior })

    await update({ show: false, messages: [] })
    await update({ show: false, messages: [], streamLive: true })
    await update({ messages: [], streamLive: true })
    await update({ messages: [], streamingText: 'Done.', streamLive: true })
    await update({ messages: prior, streamingText: 'Done.', streamLive: true })

    expect(streaming()).toBe('Done.')
  })

  it('hides a repeated part whose own turn landed during a mid-turn gap', async () => {
    // Between parts the status frame carries no assistant text (a tool call), so
    // the stream goes textless while the turn is still live and the part that
    // just finished lands in the transcript. Re-anchoring on that tick would
    // adopt it as history and render it a second time.
    const prior = [assistantTurn('a1', 'Done.')]
    await render({ messages: prior })
    await update({ messages: prior, streamingText: 'Done.', streamLive: true })
    expect(streaming()).toBe('Done.')

    const landed = [...prior, assistantTurn('a2', 'Done.')]
    await update({ messages: landed, streamLive: true })
    await update({ messages: landed, streamingText: 'Done.', streamLive: true })

    expect(streaming()).toBeNull()
  })

  it("does not carry one chat's baseline into another stream identity", async () => {
    const prior = [assistantTurn('a1', 'Shared answer text')]
    await render({ messages: prior, identity: 'tab-a' })

    await update({
      messages: prior,
      streamingText: 'Shared answer',
      streamLive: true,
      identity: 'tab-b'
    })

    expect(streaming()).toBeNull()
  })
})

describe('MobileNativeChatOverlay async question placement', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  /** The prompt-slot cards handed to the chat view, rendered, as their element types in order. */
  async function slotCards(tick: Tick): Promise<{ type: string; model?: unknown }[]> {
    await act(async () => {
      renderer = create(overlayElement(tick))
    })
    const view = renderer!.root.find((node) => node.type === 'ChatView')
    const rendered: { slot?: ReactTestRenderer } = {}
    await act(async () => {
      rendered.slot = create(view.props.queuedSlot.cards)
    })
    const nodes = rendered.slot!.root.findAll((node) => typeof node.type === 'string')
    const cards = nodes.map((node) => ({ type: String(node.type), model: node.props.model }))
    act(() => rendered.slot?.unmount())
    return cards
  }

  it('adds the async card to the prompt slot after the queued cards, beside the composer', async () => {
    const cards = await slotCards({})

    expect(cards.map((card) => card.type)).toEqual(['Queued', 'AsyncQuestions'])
    expect(cards[1]?.model).toBe(asyncQuestionsModel)
  })

  it.each(['nativeChatAsk', 'nativeChatPermission', 'nativeChatQuestion'] as const)(
    'leaves the prompt slot to a blocking %s card',
    async (blocking) => {
      const cards = await slotCards({ blocking })

      expect(cards.map((card) => card.type)).toEqual(['Queued'])
    }
  )
})

describe('MobileNativeChatOverlay async question tool rows', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  const asking: NativeChatMessage[] = [
    assistantTurn('a1', 'Which name?'),
    {
      id: 'c1',
      role: 'assistant',
      blocks: [
        {
          type: 'tool-call',
          name: 'request_user_input_async',
          input: '{"questions":[{"title":"Which name?","options":["core","base"]}]}',
          callId: 'call-1'
        }
      ],
      timestamp: 0,
      source: 'hook'
    }
  ]

  async function foldedText(asyncQuestions: NativeChatAsyncQuestionsView): Promise<string> {
    await act(async () => {
      renderer = create(overlayElement({ messages: asking, asyncQuestions }))
    })
    return JSON.stringify(renderer!.root.find((node) => node.type === 'ChatView').props.folded)
  }

  it('folds the call away only while the card shows its questions', async () => {
    const shown = await foldedText({
      state: 'ready',
      questions: [
        { key: '["request_user_input_async","call-1",0]', index: 0, title: 'Which name?' }
      ]
    })
    expect(shown).not.toContain('request_user_input_async')
    act(() => renderer?.unmount())
    // An older host publishes no set: the row and its options stay, as before.
    const absent = await foldedText({ state: 'absent' })
    expect(absent).toContain('request_user_input_async')
    expect(absent).toContain('base')
  })

  it('folds the call away while the host is still deriving, so a cold open never flashes it', async () => {
    expect(await foldedText({ state: 'pending' })).not.toContain('request_user_input_async')
  })
})
