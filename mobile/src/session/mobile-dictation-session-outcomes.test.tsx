// Mount the real composing hooks over native capture: refused starts and lost transcripts were in how the session hook and dictation hook meet, which isolated handler tests would miss.
import { createElement, useRef } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeRpcClient, type FakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import type * as NativeChatSendError from './native-chat/use-mobile-native-chat-send-error'
import type * as NativeChatDraftStore from './native-chat/composer/mobile-native-chat-draft-store'

type ChatView = { shown: boolean; scope: string | null }

const seen = vi.hoisted(() => {
  const chat: ChatView = { shown: false, scope: null }
  return {
    toasts: new Array<string>(),
    errorHaptics: 0,
    setupSheetOpens: 0,
    micPermissionRequests: 0,
    clipboard: new Array<string>(),
    inputs: new Array<string>(),
    chat,
    chatWrites: new Array<[string | null, string]>(),
    audioListeners: new Map<string, (event: { data: string }) => void>()
  }
})

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'ios' }
}))
vi.mock('@orca/expo-two-way-audio', () => ({
  addExpoTwoWayAudioEventListener: (name: string, listener: (event: { data: string }) => void) => {
    seen.audioListeners.set(name, listener)
    return { remove: () => seen.audioListeners.delete(name) }
  },
  initialize: () => Promise.resolve(true),
  requestMicrophonePermissionsAsync: () => {
    seen.micPermissionRequests += 1
    return Promise.resolve({ granted: true })
  },
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
  },
  triggerEdgeBump: () => {},
  triggerSelection: () => {}
}))
vi.mock('../platform/clipboard', () => {
  const writer = {
    writeText: async (text: string) => {
      seen.clipboard.push(text)
    }
  }
  return { useClipboardWriter: () => writer }
})

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
    showNativeChat: seen.chat.shown,
    showNativeChatRef: { current: seen.chat.shown },
    chatComposerScopeKey: seen.chat.scope,
    setChatComposerText: (update: (current: string) => string) => {
      seen.chatWrites.push([seen.chat.scope, update('')])
    }
  })
}))
vi.mock('./native-chat/composer/mobile-native-chat-draft-store', async (importOriginal) => ({
  ...(await importOriginal<typeof NativeChatDraftStore>()),
  editMobileNativeChatDraft: (scope: string, update: (current: string) => string) => {
    seen.chatWrites.push([scope, update('')])
  }
}))
vi.mock('./use-mobile-send-completion-generation', () => ({
  useMobileSendCompletionGeneration: () => () => 0
}))

import { useMobileSessionNativeChatDictation } from './use-mobile-session-native-chat-dictation'

type Model = ReturnType<typeof useMobileSessionNativeChatDictation>

function mount(
  client: FakeRpcClient,
  options: { liveInput: boolean; sendLive: () => Promise<boolean> }
): { current: () => Model } {
  const held: { model: Model | null } = { model: null }

  function Probe(): null {
    const scope = {
      hostId: 'h1',
      worktreeId: 'w1',
      client,
      connState: 'connected',
      agentSessionHostSupport: { promptCancel: true, questionAnswers: false },
      setInput: (update: (current: string) => string) => {
        seen.inputs.push(update(''))
      },
      liveInputTerminalHandles: new Set<string>(options.liveInput ? ['t1'] : []),
      activeHandle: 't1',
      activeSessionTabId: 'tab1',
      activeSessionTab: { id: 'tab1', type: 'terminal', terminal: 't1' },
      diffComments: [],
      diffCommentsRef: useRef([]),
      setShowDictationSetup: (next: boolean) => {
        if (next) {
          seen.setupSheetOpens += 1
        }
      },
      setDictationMode: () => {},
      dictationEnabled: true,
      setDictationEnabled: () => {},
      deviceTokenRef: useRef('dev'),
      dictationRouteContextRef: useRef(null),
      commandFieldAnchorRef: useRef(null),
      activeHandleRef: useRef('t1'),
      flushPendingLiveInputBeforeExternalSend: async () => true,
      canSend: true,
      canCompose: true,
      liveInputEnabled: options.liveInput,
      showToast: (message: string) => {
        seen.toasts.push(message)
      },
      resetLiveInputFocus: () => {}
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scope carries every member this hook destructures; the rest of the session model is unreachable from the mic path.
    held.model = useMobileSessionNativeChatDictation(scope as never, options.sendLive)
    return null
  }

  act(() => {
    create(createElement(Probe))
  })
  return {
    current: () => {
      if (!held.model) {
        throw new Error('Probe did not render')
      }
      return held.model
    }
  }
}

// Answer every request the hooks send, including chained ones, until none remain.
async function settle(
  rpc: FakeRpcClient,
  transcript: string,
  refuseStartWith?: string
): Promise<string[]> {
  const methods: string[] = []
  await act(async () => {
    for (let round = 0; round < 12; round += 1) {
      for (const request of rpc.requests.splice(0)) {
        methods.push(request.method)
        request.resolve(
          refuseStartWith !== undefined && request.method === 'speech.dictation.start'
            ? { id: 'desktop', ok: false, error: { code: 'refused', message: refuseStartWith } }
            : {
                id: 'desktop',
                ok: true,
                result: request.method === 'speech.dictation.finish' ? { text: transcript } : {}
              }
        )
      }
      await Promise.resolve()
      await Promise.resolve()
    }
  })
  return methods
}

async function startRecording(
  rpc: FakeRpcClient,
  options: { liveInput: boolean; sendLive?: () => Promise<boolean> }
): Promise<{ current: () => Model }> {
  const mounted = mount(rpc, {
    liveInput: options.liveInput,
    sendLive: options.sendLive ?? (async () => true)
  })
  act(() => mounted.current().handleDictationToggle())
  await settle(rpc, '')
  expect(mounted.current().dictation.isRecording).toBe(true)
  return mounted
}

beforeEach(() => {
  seen.toasts.length = 0
  seen.errorHaptics = 0
  seen.setupSheetOpens = 0
  seen.micPermissionRequests = 0
  seen.clipboard.length = 0
  seen.inputs.length = 0
  seen.chat = { shown: false, scope: null }
  seen.chatWrites.length = 0
  seen.audioListeners.clear()
})

async function tapAndRefuseStart(code: string): Promise<void> {
  const rpc = createFakeRpcClient()
  const mounted = mount(rpc, { liveInput: false, sendLive: async () => true })
  act(() => mounted.current().handleDictationToggle())
  await settle(rpc, '', code)
}

describe('a mic tap the desktop refuses because dictation is not set up', () => {
  // Exercise both disabled-profile and missing-model start refusals.
  for (const code of ['voice_dictation_disabled', 'voice_model_not_ready:not-downloaded']) {
    it(`opens the dictation setup sheet for ${code}`, async () => {
      await tapAndRefuseStart(code)
      expect(seen.setupSheetOpens).toBe(1)
      expect(seen.toasts).toEqual([])
    })
  }
})

describe('a mic tap after the host reported dictation is not set up', () => {
  it('opens setup without asking for the microphone, then lets the host judge the tap after the sheet closes', async () => {
    const rpc = createFakeRpcClient()
    const mounted = mount(rpc, { liveInput: false, sendLive: async () => true })
    await act(async () => {
      const read = mounted.current().refreshDictationMode()
      for (const request of rpc.requests.splice(0)) {
        request.resolve({
          id: 'desktop',
          ok: true,
          result: { enabled: false, selectedModelId: '', dictationMode: 'toggle', models: [] }
        })
      }
      await read
    })
    act(() => mounted.current().handleDictationToggle())
    expect(seen.setupSheetOpens).toBe(1)
    expect(seen.micPermissionRequests).toBe(0)
    expect(rpc.requests).toEqual([])

    // Closing the sheet hands the next tap to the host until a fresh read lands.
    act(() => mounted.current().closeDictationSetup())
    act(() => mounted.current().handleDictationToggle())
    await settle(rpc, '')
    expect(seen.setupSheetOpens).toBe(1)
    expect(seen.micPermissionRequests).toBe(1)
  })
})

describe('a mic tap the desktop refuses for a reason setup cannot fix', () => {
  it('toasts the host refusal in plain words with the error haptic', async () => {
    await tapAndRefuseStart('dictation_already_active')
    expect(seen.setupSheetOpens).toBe(0)
    expect(seen.toasts).toEqual(['Dictation is already in use on the computer or another phone.'])
    expect(seen.errorHaptics).toBe(1)
  })
})

describe('an audio interruption while recording', () => {
  it('finishes the dictation and keeps what was said', async () => {
    const rpc = createFakeRpcClient()
    await startRecording(rpc, { liveInput: false })
    act(() => seen.audioListeners.get('onAudioInterruption')?.({ data: 'began' }))
    const methods = await settle(rpc, 'call me back')
    expect(methods).toContain('speech.dictation.finish')
    expect(methods).not.toContain('speech.dictation.cancel')
    expect(seen.inputs).toEqual(['call me back'])
    expect(seen.toasts).toEqual([])
  })

  it('says the microphone was interrupted when nothing was transcribed', async () => {
    const rpc = createFakeRpcClient()
    await startRecording(rpc, { liveInput: false })
    act(() => seen.audioListeners.get('onAudioInterruption')?.({ data: 'blocked' }))
    await settle(rpc, '')
    expect(seen.toasts).toEqual([
      'Voice dictation stopped because the microphone was interrupted. Try again.'
    ])
  })
})

describe('leaving the session while recording', () => {
  it('stops and inserts what was said instead of leaving, and lets the next leave go', async () => {
    const rpc = createFakeRpcClient()
    const mounted = await startRecording(rpc, { liveInput: false })
    const held: boolean[] = []
    act(() => {
      held.push(mounted.current().dictationLeaveHold.hold())
    })
    // Back is released while transcribing, so a swipe can leave too.
    expect(mounted.current().dictationLeaveHold.holdsLeave).toBe(false)
    act(() => {
      held.push(mounted.current().dictationLeaveHold.hold())
    })
    expect(held).toEqual([true, false])
    const methods = await settle(rpc, 'one more thing')
    expect(methods.filter((method) => method === 'speech.dictation.finish')).toHaveLength(1)
    expect(methods).not.toContain('speech.dictation.cancel')
    expect(seen.inputs).toEqual(['one more thing'])
    expect(seen.toasts).toEqual([])
  })
})

describe('a mic tap while the transcript is processing', () => {
  it('keeps the transcript that comes back', async () => {
    const rpc = createFakeRpcClient()
    const mounted = await startRecording(rpc, { liveInput: false })
    act(() => mounted.current().handleDictationToggle())
    expect(mounted.current().dictation.isProcessing).toBe(true)
    act(() => mounted.current().handleDictationToggle())
    const methods = await settle(rpc, 'ship it')
    expect(methods).not.toContain('speech.dictation.cancel')
    expect(seen.inputs).toEqual(['ship it'])
  })
})

describe('a live terminal insert that fails', () => {
  const failures: [string, () => Promise<boolean>][] = [
    ['is refused', async () => false],
    [
      'throws',
      async () => {
        throw new Error('mirror step failed')
      }
    ]
  ]
  for (const [label, sendLive] of failures) {
    it(`copies the transcript to the clipboard and says so when the send ${label}`, async () => {
      const rpc = createFakeRpcClient()
      const mounted = await startRecording(rpc, { liveInput: true, sendLive })
      act(() => mounted.current().handleDictationToggle())
      await settle(rpc, 'git status')
      expect(seen.clipboard).toEqual(['git status'])
      expect(seen.toasts).toEqual(["Couldn't insert dictation, so it was copied to the clipboard"])
    })
  }
})

describe('a dictation that ends after switching between chat and terminal', () => {
  it('lands in the chat it started in, where its words were shown', async () => {
    seen.chat = { shown: true, scope: 'chat-a' }
    const rpc = createFakeRpcClient()
    const mounted = await startRecording(rpc, { liveInput: false })
    seen.chat = { shown: false, scope: 'chat-b' }
    act(() => mounted.current().handleDictationToggle())
    await settle(rpc, 'ship it')
    expect(seen.chatWrites).toEqual([['chat-a', 'ship it']])
    expect(seen.inputs).toEqual([])
  })

  it('lands in the chat that replaced the terminal it started in', async () => {
    const rpc = createFakeRpcClient()
    const mounted = await startRecording(rpc, { liveInput: false })
    seen.chat = { shown: true, scope: 'chat-b' }
    act(() => mounted.current().handleDictationToggle())
    await settle(rpc, 'ship it')
    expect(seen.chatWrites).toEqual([['chat-b', 'ship it']])
    expect(seen.inputs).toEqual([])
  })
})
