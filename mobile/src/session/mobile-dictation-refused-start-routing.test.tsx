/**
 * A desktop that refuses `speech.dictation.start`, reaching the composer the user actually tapped.
 *
 * The sibling suites mount their own copy of the composer's handler; this one mounts the real
 * `useMobileSessionNativeChatDictation` over the real `useMobileDictation`, because the defect was
 * in the wiring between them rather than in either half.
 */
import { createElement, useRef } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeRpcClient, type FakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'

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

// The native-chat surface this hook composes with. None of it is on the mic's path, and reaching
// the real modules would pull the Expo runtime in behind them.
vi.mock('./use-mobile-native-chat-send-error', () => ({
  useMobileNativeChatSendError: () => ({
    message: null,
    show: () => {},
    clear: () => {},
    bannerMountedRef: { current: false }
  })
}))
vi.mock('./use-mobile-native-chat-readability', () => ({
  useMobileNativeChatReadability: () => false
}))
vi.mock('./use-mobile-native-chat-input-lease', () => ({
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
      agentSessionPromptCancelSupported: true,
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

/** Answers every forwarded request, refusing `speech.dictation.start` with the desktop's own code. */
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
  // The two codes a desktop with no usable model answers with: `voice_dictation_disabled` from a
  // profile that never enabled voice, `voice_model_not_ready:` from one whose model dir is empty.
  for (const code of ['voice_dictation_disabled', 'voice_model_not_ready:not-downloaded']) {
    it(`opens the dictation setup sheet for ${code}`, async () => {
      const rpc = createFakeRpcClient()
      const mounted = mount(rpc)
      await tapAndRefuseStart(mounted, rpc, code)
      expect(mounted.setupSheetOpens).toHaveLength(1)
      // And the desktop's internal code is never shown as product copy.
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
