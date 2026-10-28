import { createElement, useEffect, useRef } from 'react'
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../transport/types'

const env = vi.hoisted(() => ({
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
}))

vi.mock('../platform/clipboard', () => ({
  useClipboardWriter: () => ({ writeText: async () => {} })
}))
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
// Stub unused capture/native-chat paths to avoid Expo runtime imports.
vi.mock('../hooks/use-mobile-dictation', () => ({
  useMobileDictation: (options: { enabled: boolean }) => {
    env.captureEnabled = options.enabled
    return {
      isStarting: false,
      isRecording: false,
      isProcessing: false,
      start: async () => {},
      stop: async () => {},
      cancel: async () => {}
    }
  }
}))
vi.mock('./native-chat/use-mobile-native-chat-send-error', () => ({
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
    toggleTabChatView: () => {},
    showNativeChat: false,
    showNativeChatRef: { current: false },
    setChatComposerText: () => {}
  })
}))
vi.mock('./use-mobile-send-completion-generation', () => ({
  useMobileSendCompletionGeneration: () => () => 0
}))

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

// Keep client identity stable across reconnects; refuse sends while disconnected.
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
    activeSessionTabId: 'tab',
    activeSessionTab: null,
    activeHandleRef,
    dictationRouteContextRef,
    deviceTokenRef,
    flushPendingLiveInputBeforeExternalSend: async () => true,
    canSend: env.connected,
    liveInputEnabled: false,
    showToast: () => {},
    resetLiveInputFocus: () => {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the native-chat dependencies are mocked; the real screen state and the mode read are exercised together.
  const voice = useMobileSessionNativeChatDictation(scope as never, async () => true)
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
    // Deliver the pre-drop answer last to prove it cannot override the new generation.
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

  it('offers the mic on a host that never had a speech model selected', async () => {
    env.connected = true
    env.deferReply = true
    env.slowReply = Promise.resolve({
      id: 'first-run',
      ok: true,
      result: { enabled: false, selectedModelId: '', dictationMode: 'toggle', models: [] }
    })
    await render()
    expect(micBinding()).toBe('toggle')
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
