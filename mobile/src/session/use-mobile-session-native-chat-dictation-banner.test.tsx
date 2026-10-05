/**
 * Where a late native-chat send failure lands: the composer's banner only while that banner is
 * mounted. The identity gate replaces the composer, so a failure then must fall back to the toast.
 */
import { createElement, useRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const held = vi.hoisted(() => {
  const state: {
    bannerMountedRef: { current: boolean }
    showNativeChat: boolean
    nativeChatAgent: string | null
  } = { bannerMountedRef: { current: false }, showNativeChat: true, nativeChatAgent: null }
  return state
})

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
vi.mock('../platform/haptics', () => ({ triggerError: () => {} }))
vi.mock('./use-mobile-native-chat-send-error', () => ({
  useMobileNativeChatSendError: () => ({
    message: null,
    show: () => {},
    clear: () => {},
    bannerMountedRef: held.bannerMountedRef
  })
}))
vi.mock('./use-mobile-native-chat-readability', () => ({
  useMobileNativeChatReadabilityState: () => 'readable'
}))
vi.mock('./use-mobile-session-chat-view', () => ({
  useMobileSessionChatView: () => ({
    markerSession: true,
    tabLeafView: () => 'chat',
    isTabChatView: () => true,
    setTabChatView: () => {},
    retainedIdentity: () => null
  })
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
    setTabChatView: () => {},
    showNativeChat: held.showNativeChat,
    showNativeChatRef: { current: held.showNativeChat },
    nativeChatAgent: held.nativeChatAgent,
    setChatComposerText: () => {}
  })
}))
vi.mock('./use-mobile-send-completion-generation', () => ({
  useMobileSendCompletionGeneration: () => () => 0
}))

import { useMobileSessionNativeChatDictation } from './use-mobile-session-native-chat-dictation'

function Probe(): null {
  const scope = {
    hostId: 'h1',
    worktreeId: 'w1',
    client: null,
    connState: 'connected',
    agentSessionHostSupport: null,
    setInput: () => {},
    liveInputTerminalHandles: new Set<string>(),
    activeHandle: 't1',
    activeSessionTabId: 'P::A',
    activeSessionTab: { id: 'P::A', type: 'terminal', terminal: 't1' },
    diffComments: [],
    diffCommentsRef: useRef([]),
    setShowDictationSetup: () => {},
    setDictationMode: () => {},
    deviceTokenRef: useRef('dev'),
    dictationRouteContextRef: useRef(null),
    activeHandleRef: useRef('t1'),
    flushPendingLiveInputBeforeExternalSend: async () => true,
    canSend: true,
    liveInputEnabled: false,
    showToast: () => {},
    resetLiveInputFocus: () => {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scope carries every member this hook destructures; the rest of the session model is unreachable here.
  useMobileSessionNativeChatDictation(scope as never, async () => true)
  return null
}

describe('the native-chat send-error banner while the identity gate shows (R3-F4)', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render(agent: string | null): void {
    held.nativeChatAgent = agent
    act(() => {
      renderer = create(createElement(Probe))
    })
  }

  it('is not counted as mounted, so a late failure falls back to the toast', () => {
    render(null)
    expect(held.bannerMountedRef.current).toBe(false)
  })

  it('is counted as mounted while the composer shows', () => {
    render('claude')
    expect(held.bannerMountedRef.current).toBe(true)
  })
})
