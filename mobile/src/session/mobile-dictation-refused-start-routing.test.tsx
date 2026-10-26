// Mount the real composing hooks: the refused-start defect was in their wiring, which independent handler copies would miss.
import { createElement, useRef } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeRpcClient, type FakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import type * as NativeChatSendError from './native-chat/use-mobile-native-chat-send-error'

const seen = vi.hoisted(() => ({
  toasts: new Array<string>(),
  errorHaptics: 0
}))

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'ios' }
}))
vi.mock('@orca/expo-two-way-audio', () => ({
  addExpoTwoWayAudioEventListener: () => ({ remove: () => {} }),
  initialize: () => Promise.resolve(true),
  requestMicrophonePermissionsAsync: () => Promise.resolve({ granted: true }),
  tearDown: () => {},
  toggleRecording: () => true
}))
vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: () => Promise.resolve(),
  deactivateKeepAwake: () => Promise.resolve()
}))
vi.mock('expo-router', () => ({ useFocusEffect: () => {} }))
vi.mock('../platform/haptics', () => ({
  triggerError: () => {
    seen.errorHaptics += 1
  }
}))

// Stub off-path native chat dependencies to keep Expo out of this mic test.
vi.mock('./native-chat/use-mobile-native-chat-send-error', async (importOriginal) => ({
  ...(await importOriginal<typeof NativeChatSendError>()),
  useMobileNativeChatSendError: () => ({
    message: null,
    show: () => {},
    clear: () => {},
    keepWhile: () => {},
    bannerMountedRef: { current: false }
  })
}))
vi.mock('./use-mobile-native-chat-readability', () => ({
  useMobileNativeChatReadability: () => false
}))
vi.mock('./native-chat/use-mobile-native-chat-input-lease', () => ({
  useMobileNativeChatInputLease: () => ({
    ready: true,
    readyRef: { current: true },
    lockReason: null,
    markReady: () => {},
    clear: () => {}
  })
}))
vi.mock('./use-mobile-native-chat-controller', () => ({
  useMobileNativeChatController: () => ({
    nativeChatSession: { messages: [] },
    toggleTabChatView: () => {},
    showNativeChat: false,
    showNativeChatRef: { current: false },
    setChatComposerText: () => {}
  })
}))
vi.mock('./use-mobile-send-completion-generation', () => ({
  useMobileSendCompletionGeneration: () => () => 0
}))

import { useMobileSessionNativeChatDictation } from './use-mobile-session-native-chat-dictation'

type Mounted = {
  readonly tap: () => void
  readonly setupSheetOpens: number[]
}

function mount(client: FakeRpcClient): Mounted {
  const setupSheetOpens: number[] = []
  const held: { start: (() => void) | null } = { start: null }

  function Probe(): null {
    const dictationRouteContextRef = useRef(null)
    const activeHandleRef = useRef('t1')
    const deviceTokenRef = useRef('dev')
    const diffCommentsRef = useRef([])
    const scope = {
      hostId: 'h1',
      worktreeId: 'w1',
      client,
      connState: 'connected',
      agentSessionHostSupport: { promptCancel: true, questionAnswers: false },
      setInput: () => {},
      liveInputTerminalHandles: new Set<string>(),
      activeHandle: 't1',
      activeSessionTabId: 'tab1',
      activeSessionTab: { id: 'tab1', type: 'terminal', terminal: 't1' },
      diffComments: [],
      diffCommentsRef,
      setShowDictationSetup: (next: boolean) => {
        if (next) {
          setupSheetOpens.push(setupSheetOpens.length + 1)
        }
      },
      setDictationMode: () => {},
      dictationEnabled: true,
      setDictationEnabled: () => {},
      deviceTokenRef,
      dictationRouteContextRef,
      activeHandleRef,
      flushPendingLiveInputBeforeExternalSend: async () => true,
      canSend: true,
      liveInputEnabled: false,
      showToast: (message: string) => {
        seen.toasts.push(message)
      },
      resetLiveInputFocus: () => {}
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scope carries every member this hook destructures; the rest of the session model is unreachable from the mic path.
    const model = useMobileSessionNativeChatDictation(scope as never, async () => true)
    held.start = model.startDictation
    return null
  }

  act(() => {
    create(createElement(Probe))
  })
  return {
    tap: () => held.start?.(),
    setupSheetOpens
  }
}

async function tapAndRefuseStart(
  mounted: Mounted,
  rpc: FakeRpcClient,
  code: string
): Promise<void> {
  await act(async () => {
    mounted.tap()
    for (let round = 0; round < 8; round += 1) {
      for (const request of rpc.requests.splice(0)) {
        request.resolve(
          request.method === 'speech.dictation.start'
            ? { id: 'desktop', ok: false, error: { code: 'refused', message: code } }
            : { id: 'desktop', ok: true, result: {} }
        )
      }
      await Promise.resolve()
      await Promise.resolve()
    }
  })
}

beforeEach(() => {
  seen.toasts.length = 0
  seen.errorHaptics = 0
})

describe('a mic tap the desktop refuses because dictation is not set up', () => {
  // Exercise both disabled-profile and missing-model start refusals.
  for (const code of ['voice_dictation_disabled', 'voice_model_not_ready:not-downloaded']) {
    it(`opens the dictation setup sheet for ${code}`, async () => {
      const rpc = createFakeRpcClient()
      const mounted = mount(rpc)
      await tapAndRefuseStart(mounted, rpc, code)
      expect(mounted.setupSheetOpens).toHaveLength(1)
      expect(seen.toasts).toEqual([])
    })
  }
})

describe('a mic tap the desktop refuses for a reason setup cannot fix', () => {
  it('still toasts the host message with the error haptic', async () => {
    const rpc = createFakeRpcClient()
    const mounted = mount(rpc)
    await tapAndRefuseStart(mounted, rpc, 'dictation_already_active')
    expect(mounted.setupSheetOpens).toEqual([])
    expect(seen.toasts).toEqual(['dictation_already_active'])
    expect(seen.errorHaptics).toBe(1)
  })
})
