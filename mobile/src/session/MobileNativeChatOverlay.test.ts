import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileNativeChatOverlay } from './MobileNativeChatOverlay'
import type { MobileNativeChatController } from './use-mobile-native-chat-controller'
import type { MobileImageSource } from '../platform/media-picker-contract'
import { findAllByHostType, findByHostType } from '../test-support/react-test-renderer-host-nodes'

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles, absoluteFillObject: {} },
  View: 'View'
}))

vi.mock('./MobileNativeChatView', () => ({ MobileNativeChatView: 'ChatView' }))
vi.mock('../platform/use-reduced-motion', () => ({ useReducedMotionEnabled: () => null }))
vi.mock('./MobileNativeChatQueuedMessages', () => ({ MobileNativeChatQueuedMessages: 'Queued' }))
vi.mock('./MobileNativeChatBackgroundTasks', () => ({
  MobileNativeChatBackgroundTasks: 'BackgroundTasks'
}))
vi.mock('./MobileNativeChatVisual', () => ({ useMobileNativeChatVisualRenderer: () => null }))
vi.mock('./MobileNativeChatRowOverlaysHost', () => ({
  MobileNativeChatRowOverlaysHost: 'View'
}))

function assistantTurn(id: string, text: string): NativeChatMessage {
  return { id, role: 'assistant', blocks: [{ type: 'text', text }], timestamp: 0, source: 'hook' }
}

type Tick = {
  show?: boolean
  messages?: NativeChatMessage[]
  streamingText?: string
  streamLive?: boolean
  identity?: string
  stopping?: boolean
  acceptsImages?: boolean
  agent?: string
  structured?: boolean
  activeTabId?: string | null
  setTabView?: (tabId: string, view: 'terminal') => void
  attachImage?: (source: MobileImageSource) => Promise<void>
}

function overlayElement(tick: Tick): ReturnType<typeof createElement> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the overlay reads only these controller members; the rest of the controller is unreachable from it.
  const controller = {
    showNativeChat: tick.show ?? true,
    nativeChatSession: { messages: tick.messages ?? [], status: 'ready' },
    nativeChatAgent: tick.agent ?? 'claude',
    nativeChatStructured: tick.structured ?? false,
    setTabView: tick.setTabView ?? vi.fn(),
    nativeChatAcceptsImages: tick.acceptsImages ?? true,
    nativeChatAgentWorking: tick.streamLive ?? false,
    nativeChatTurnIndicator: {
      thinking: false,
      activityText: null,
      stopping: tick.stopping ?? false
    },
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
    }
  } as unknown as MobileNativeChatController
  return createElement(MobileNativeChatOverlay, {
    controller,
    activeSessionTabId: tick.activeTabId,
    onOpenFile: vi.fn(),
    images: {
      attachments: [],
      isAttaching: false,
      attachImage: tick.attachImage ?? vi.fn(async () => {}),
      removeAttachment: vi.fn(),
      sendNativeChat: vi.fn(async () => true)
    },
    onMicPress: vi.fn(),
    micActive: false,
    dictationMode: 'toggle',
    onMicPressIn: vi.fn(),
    onMicPressOut: vi.fn(),
    inputLockReason: null,
    sendErrorMessage: null,
    onClearSendError: vi.fn(),
    sendSurfaceId: tick.identity ?? 'tab-a',
    sessionId: null,
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

  function streaming(): string | null | 'hidden' {
    const views = findAllByHostType(renderer!.root, 'ChatView')
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
    // Keep the baseline above chat-list unmounts so repeated-prefix replies still stream after terminal toggles.
    const prior = [assistantTurn('a1', 'Done.')]
    await render({ messages: prior })
    await update({ messages: prior, streamingText: 'Done.', streamLive: true })
    expect(streaming()).toBe('Done.')

    await update({ show: false, messages: [], streamLive: true })
    expect(streaming()).toBe('hidden')
    // Status streaming returns before the transcript refresh; that round-trip gap must remain visible.
    await update({ messages: [], streamLive: true })
    await update({ messages: [], streamingText: 'Done.', streamLive: true })
    await update({ messages: prior, streamingText: 'Done.', streamLive: true })

    expect(streaming()).toBe('Done.')
  })

  it('keeps the bubble across a peek at the terminal taken between turns', async () => {
    // An idle toggle must not replace the baseline with an empty withheld transcript.
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
    // Textless tool ticks must not adopt the just-finished part as history and draw it twice.
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

describe("MobileNativeChatOverlay while a person's Stop ends the turn", () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  async function steerHeld(tick: Tick): Promise<unknown> {
    await act(async () => {
      renderer = create(overlayElement(tick))
    })
    const view = findByHostType(renderer!.root, 'ChatView')
    return view.props.composerTray?.content?.props?.children?.[1]?.props?.steerHeld
  }

  it("holds the queued cards' Steer while the agent works and the host says Stopping", async () => {
    expect(await steerHeld({ streamLive: true, stopping: true })).toBe(true)
  })

  it('leaves Steer to the cards otherwise', async () => {
    expect(await steerHeld({ streamLive: true, stopping: false })).toBe(false)
  })
})

describe('MobileNativeChatOverlay attach button', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('opens the exact active terminal tab for an OMP bridge question', async () => {
    const setTabView = vi.fn()
    await act(async () => {
      renderer = create(overlayElement({ agent: 'omp', activeTabId: 'tab-omp', setTabView }))
    })
    const view = findByHostType(renderer!.root, 'ChatView')
    expect(view.props.askRequiresTerminal).toBe(true)
    act(() => view.props.onAnswerInTerminal())
    expect(setTabView).toHaveBeenCalledExactlyOnceWith('tab-omp', 'terminal')
  })

  it.each(['structured', 'claude', 'missing tab'])(
    'keeps the terminal-only gate scoped correctly: %s',
    async (scenario) => {
      await act(async () => {
        renderer = create(
          overlayElement({
            agent: scenario === 'claude' ? 'claude' : 'omp',
            structured: scenario === 'structured',
            activeTabId: scenario === 'missing tab' ? null : 'tab-omp'
          })
        )
      })
      const view = findByHostType(renderer!.root, 'ChatView')
      expect(view.props.askRequiresTerminal).toBe(scenario === 'missing tab')
      if (scenario === 'missing tab') {
        expect(view.props.onAnswerInTerminal).toBeUndefined()
      }
    }
  )

  it.each([true, false])('offers attach only when the agent takes images (%s)', async (accepts) => {
    const attachImage = vi.fn(async () => {})
    await act(async () => {
      renderer = create(overlayElement({ acceptsImages: accepts, attachImage }))
    })
    const view = findByHostType(renderer!.root, 'ChatView')
    expect(typeof view.props.onAttachImage === 'function').toBe(accepts)
    if (accepts) {
      await act(async () => view.props.onAttachImage())
      expect(attachImage).toHaveBeenCalledExactlyOnceWith('library')
    } else {
      expect(attachImage).not.toHaveBeenCalled()
    }
  })
})
