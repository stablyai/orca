// Exercise the real screen state and mic bindings across connection, focus and foreground changes.
import { createElement, useEffect, useRef } from 'react'
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../transport/types'

const env = vi.hoisted(
  (): {
    native: boolean
    tab: string
    starts: number
    transcript: ((text: string) => void) | null
    toasts: string[]
    focused: boolean
    connected: boolean
    mode: string
    reads: number
    enabled: boolean
    captureEnabled: boolean
    foreground: Set<(state: string) => void>
    slowReply: Promise<RpcResponse | null>
    deferReply: boolean
    refuseRead: boolean
  } => ({
    native: false,
    tab: 'tab',
    starts: 0,
    transcript: null,
    toasts: [],
    focused: true,
    connected: false,
    mode: 'hold',
    reads: 0,
    enabled: true,
    captureEnabled: false,
    foreground: new Set<(state: string) => void>(),
    slowReply: Promise.resolve<RpcResponse | null>(null),
    deferReply: false,
    refuseRead: false
  })
)

vi.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    useEffect(() => (env.focused ? effect() : undefined), [effect, env.focused])
  }
}))
vi.mock('react-native', () => ({
  Animated: { Value: class {} },
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  AppState: {
    currentState: 'active',
    addEventListener: (_event: string, listener: (state: string) => void) => {
      env.foreground.add(listener)
      return { remove: () => env.foreground.delete(listener) }
    }
  }
}))
vi.mock('lucide-react-native', () => ({ ImagePlus: 'ImagePlus', Mic: 'Mic' }))
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }))
vi.mock('../platform/haptics', () => ({ triggerError: () => {} }))
vi.mock('./use-terminal-live-input-mode-preference', () => ({
  useTerminalLiveInputModePreference: () => ({ liveInputTerminalHandles: new Set<string>() })
}))
// The capture pipeline and the native-chat surface are off this path; the real modules would pull
// the Expo audio runtime in behind them.
vi.mock('../hooks/use-mobile-dictation', () => ({
  useMobileDictation: (options: { enabled: boolean; onTranscript: (text: string) => void }) => {
    env.transcript = options.onTranscript
    env.captureEnabled = options.enabled
    return {
      isStarting: false,
      isRecording: false,
      isProcessing: false,
      start: async () => {
        env.starts += 1
      },
      stop: async () => {},
      cancel: async () => {}
    }
  }
}))
vi.mock('./use-mobile-native-chat-send-error', () => ({
  useMobileNativeChatSendError: () => ({
    show: () => {},
    clear: () => {},
    keepWhile: () => {},
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
  useMobileNativeChatController: () => {
    const drafts = useMobileNativeChatDrafts({
      hostId: 'host',
      worktreeId: 'worktree',
      tabId: env.tab,
      sessionId: 'session',
      messages: [],
      transcriptSettled: true
    })
    return {
      toggleTabChatView: () => {},
      showNativeChat: env.native,
      showNativeChatRef: { current: env.native },
      draftAuthoringReady: drafts.draftAuthoringReady,
      setChatComposerText: drafts.setComposerText
    }
  }
}))
vi.mock('./use-mobile-send-completion-generation', () => ({
  useMobileSendCompletionGeneration: () => () => 0
}))

import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import {
  hydrateMobileNativeChatDraft,
  readMobileNativeChatDraft,
  deleteMobileNativeChatDrafts,
  resetMobileNativeChatDraftStoreForTests
} from './mobile-native-chat-draft-store'
import { publishMobileChatDraftStorage } from './mobile-native-chat-draft-storage'
import { useMobileSessionScreenState } from './use-mobile-session-screen-state'
import { useMobileSessionNativeChatDictation } from './use-mobile-session-native-chat-dictation'
import { MobileTerminalInputActions } from './MobileTerminalInputActions'

// Mocked react-native components are string tags that ReactTestInstance's ElementType omits.
function hostType(node: ReactTestInstance): unknown {
  return node.type
}

function setupReply(mode: string, enabled = true): RpcResponse {
  return { id: 'desktop', ok: true, result: { enabled, dictationMode: mode, models: [] } }
}

// One logical client for the route's lifetime, like the shared per-host client: its identity does
// not change across a reconnect. While down it refuses sends the way a relay session does.
const client = {
  getState: () => (env.connected ? 'connected' : 'reconnecting'),
  sendRequest: async (): Promise<RpcResponse> => {
    env.reads += 1
    if (env.refuseRead) {
      throw new Error('speech.models.list unavailable')
    }
    if (!env.connected) {
      throw new Error('relay session not connected')
    }
    return (env.deferReply ? await env.slowReply : null) ?? setupReply(env.mode, env.enabled)
  }
}

let renderer: ReactTestRenderer | null = null
let voiceModel: ReturnType<typeof useMobileSessionNativeChatDictation>

function Probe() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the screen state only reads these route fields; foundation services are mocked below.
  const screen = useMobileSessionScreenState({
    hostId: 'host',
    worktreeId: 'worktree',
    initialCreateWarning: ''
  } as never)
  const activeHandleRef = useRef('terminal')
  const dictationRouteContextRef = useRef(null)
  const deviceTokenRef = useRef('device')
  const scope = {
    ...screen,
    hostId: 'host',
    worktreeId: 'worktree',
    client,
    connState: env.connected ? 'connected' : 'reconnecting',
    activeHandle: 'terminal',
    activeSessionTabId: env.tab,
    activeSessionTab: null,
    activeHandleRef,
    dictationRouteContextRef,
    deviceTokenRef,
    flushPendingLiveInputBeforeExternalSend: async () => true,
    canSend: env.connected,
    liveInputEnabled: false,
    showToast: (message: string) => {
      env.toasts.push(message)
    },
    resetLiveInputFocus: () => {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the native-chat dependencies are mocked; the real screen state and the mode read are exercised together.
  const voice = useMobileSessionNativeChatDictation(scope as never, async () => true)
  voiceModel = voice
  return createElement(MobileTerminalInputActions, {
    canSend: env.connected,
    isAttaching: false,
    dictation: voice.dictation,
    dictationMode: screen.dictationMode,
    dictationEnabled: screen.dictationEnabled,
    buttonStyle: {},
    activeButtonStyle: {},
    disabledButtonStyle: {},
    onAttachImage: () => {},
    onAttachFile: () => {},
    onDictationToggle: voice.handleDictationToggle,
    onDictationPressIn: voice.handleDictationPressIn,
    onDictationPressOut: voice.handleDictationPressOut,
    onDictationCancel: voice.cancelDictation
  })
}

async function render(): Promise<void> {
  await act(async () => {
    if (renderer) {
      renderer.update(createElement(Probe))
    } else {
      renderer = create(createElement(Probe))
    }
  })
}

/** What a press on the mic does: hold binds press-in/out, toggle binds a tap. */
function micBinding(): 'hold' | 'toggle' | 'inert' | 'hidden' {
  const mic = renderer?.root.findAll(
    (node) =>
      hostType(node) === 'Pressable' && node.props.accessibilityLabel === 'Start voice dictation'
  )[0]
  if (!mic) {
    return 'hidden'
  }
  if (mic.props.onPressIn) {
    return 'hold'
  }
  return mic?.props.onPress ? 'toggle' : 'inert'
}

beforeEach(() => {
  env.native = false
  env.tab = 'tab'
  env.starts = 0
  env.toasts.length = 0
  env.focused = true
  env.connected = false
  env.mode = 'hold'
  env.reads = 0
  env.foreground.clear()
  env.slowReply = Promise.resolve(null)
  env.deferReply = false
  env.enabled = true
  env.refuseRead = false
})

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  resetMobileNativeChatDraftStoreForTests()
  publishMobileChatDraftStorage(null)
})

describe('the mic follows the host dictation mode', () => {
  it('reads it once the client of a cold route connects, not while it is down', async () => {
    await render()
    const readsWhileDown = env.reads
    env.connected = true
    await render()
    expect({ readsWhileDown, binding: micBinding() }).toEqual({
      readsWhileDown: 0,
      binding: 'hold'
    })
  })

  it('reads it again after a reconnect of the same client', async () => {
    env.connected = true
    await render()
    expect(micBinding()).toBe('hold')
    env.connected = false
    await render()
    env.mode = 'toggle'
    env.connected = true
    await render()
    expect(micBinding()).toBe('toggle')
  })

  it('ignores a reply from the connection that dropped', async () => {
    let answerOld: (reply: RpcResponse) => void = () => {}
    env.deferReply = true
    env.slowReply = new Promise((resolve) => {
      answerOld = resolve
    })
    env.connected = true
    await render()
    env.connected = false
    await render()
    env.slowReply = Promise.resolve(null)
    env.deferReply = false
    env.connected = true
    await render()
    // The host's answer before the drop, arriving after the reconnected client's own.
    await act(async () => answerOld(setupReply('toggle', false)))
    expect(micBinding()).toBe('hold')
    expect(env.captureEnabled).toBe(true)
  })

  it('reads it again when the app returns to the foreground, only while focused', async () => {
    env.connected = true
    await render()
    expect(micBinding()).toBe('hold')
    env.mode = 'toggle'
    await act(async () => {
      for (const listener of env.foreground) {
        listener('active')
      }
    })
    expect(micBinding()).toBe('toggle')
    env.focused = false
    await render()
    expect(env.foreground.size).toBe(0)
  })

  it('hides the mic and disables capture, then restores both on foreground refresh', async () => {
    env.connected = true
    env.enabled = false
    await render()
    expect(micBinding()).toBe('hidden')
    expect(env.captureEnabled).toBe(false)
    env.enabled = true
    await act(async () => {
      for (const listener of env.foreground) {
        listener('active')
      }
    })
    expect(micBinding()).toBe('hold')
    expect(env.captureEnabled).toBe(true)
  })

  it('drops a pending reply after focus is lost', async () => {
    let answer: (reply: RpcResponse) => void = () => {}
    env.deferReply = true
    env.slowReply = new Promise((resolve) => {
      answer = resolve
    })
    env.connected = true
    await render()
    env.focused = false
    await render()
    await act(async () => answer(setupReply('hold', false)))
    expect(micBinding()).toBe('toggle')
    expect(env.captureEnabled).toBe(true)
  })

  it('keeps the newest foreground reply when earlier refreshes finish late', async () => {
    let answer: (reply: RpcResponse) => void = () => {}
    env.deferReply = true
    env.slowReply = new Promise((resolve) => {
      answer = resolve
    })
    env.connected = true
    await render()
    env.deferReply = false
    env.mode = 'hold'
    await act(async () => {
      for (const listener of env.foreground) {
        listener('active')
      }
    })
    await act(async () => answer(setupReply('toggle', false)))
    expect(micBinding()).toBe('hold')
    expect(env.captureEnabled).toBe(true)
  })

  it('keeps disabled settings when a reconnect read fails', async () => {
    env.connected = true
    env.enabled = false
    await render()
    env.connected = false
    await render()
    env.refuseRead = true
    env.connected = true
    await render()
    expect(micBinding()).toBe('hidden')
    expect(env.captureEnabled).toBe(false)
  })

  it('keeps legacy controls when the host omits the enabled field', async () => {
    env.connected = true
    env.deferReply = true
    env.slowReply = Promise.resolve({
      id: 'legacy',
      ok: true,
      result: { dictationMode: 'hold', models: [] }
    })
    await render()
    expect(micBinding()).toBe('hold')
    expect(env.captureEnabled).toBe(true)
  })
})

it('gates every native dictation start and inserts only into its captured live draft', async () => {
  env.native = true
  env.connected = true
  let loaded = (_value: string | null) => {}
  publishMobileChatDraftStorage({
    read: () =>
      new Promise((resolve) => {
        loaded = resolve
      }),
    write: async () => {},
    removeWorkspace: async () => {}
  })
  await render()
  act(() => voiceModel.startDictation())
  expect(env.starts).toBe(0)
  await act(async () => loaded(null))
  act(() => voiceModel.startDictation())
  expect(env.starts).toBe(1)
  env.tab = 'other'
  await render()
  await act(async () => loaded(null))
  act(() => env.transcript?.('spoken for original'))
  expect(readMobileNativeChatDraft('host\0worktree\0tab').text).toBe('spoken for original')
  expect(readMobileNativeChatDraft('host\0worktree\0other').text).toBe('')
  expect(env.toasts).toEqual(['Dictation inserted'])
  act(() => voiceModel.startDictation())
  await act(async () => {
    await deleteMobileNativeChatDrafts('host', 'worktree')
    void hydrateMobileNativeChatDraft('host\0worktree\0other')
  })
  act(() => env.transcript?.('retired destination'))
  expect(readMobileNativeChatDraft('host\0worktree\0other').text).toBe('')
  expect(env.toasts).toEqual(['Dictation inserted'])
})
