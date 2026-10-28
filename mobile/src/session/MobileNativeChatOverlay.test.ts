import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileNativeChatOverlay } from './MobileNativeChatOverlay'
import type { MobileNativeChatController } from './mobile-native-chat-controller-contract'
import type { MobileImageSource } from '../platform/media-picker-contract'
import { findByHostType } from '../test-support/react-test-renderer-host-nodes'

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles, absoluteFillObject: {} },
  View: 'View'
}))

vi.mock('./MobileNativeChatView', () => ({ MobileNativeChatView: 'ChatView' }))
vi.mock('../platform/use-reduced-motion', () => ({ useReducedMotionEnabled: () => null }))
vi.mock('./native-chat/input/MobileNativeChatQueuedMessages', () => ({
  MobileNativeChatQueuedMessages: 'Queued'
}))
vi.mock('./native-chat/input/MobileNativeChatBackgroundTasks', () => ({
  MobileNativeChatBackgroundTasks: 'BackgroundTasks'
}))
vi.mock('./native-chat/visual/MobileNativeChatVisual', () => ({
  useMobileNativeChatVisualRenderer: () => null
}))
vi.mock('./native-chat/transcript/MobileNativeChatRowOverlaysHost', () => ({
  MobileNativeChatRowOverlaysHost: 'View'
}))

type Tick = {
  show?: boolean
  messages?: NativeChatMessage[]
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
    nativeChatTurnIndicator: {
      thinking: false,
      activityText: null,
      stopping: tick.stopping ?? false
    },
    chatPending: [],
    chatImagePreviewsByMessageId: {},
    chatDraftKey: null,
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
    micProcessing: false,
    dictationMode: 'toggle',
    onMicPressIn: vi.fn(),
    onMicPressOut: vi.fn(),
    inputLockReason: null,
    sendErrorMessage: null,
    onClearSendError: vi.fn(),
    sendSurfaceId: 'tab-a',
    sessionId: null,
    getSendCompletionGeneration: () => 0,
    keyboardInset: 0,
    hostName: null
  })
}

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
    expect(await steerHeld({ stopping: true })).toBe(true)
  })

  it('leaves Steer to the cards otherwise', async () => {
    expect(await steerHeld({ stopping: false })).toBe(false)
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
