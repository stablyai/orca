import { createElement, useRef, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFakeRpcClient,
  type FakeRpcClient,
  type SentRequest
} from '../mobile-web-shell/bridge-host-test-fakes'
import { resolveMobileTerminalInputGate } from '../terminal/terminal-input-connection-gate'
import type { MobileSessionFeedbackCapabilitiesModel } from './use-mobile-session-feedback-capabilities'
import type { MobileSessionTab } from './mobile-session-route-types'
import type { ConnectionState } from '../transport/types'
import { structuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'

const device = vi.hoisted(() => ({ opens: 0, recording: false }))
vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'ios' }
}))
vi.mock('@orca/expo-two-way-audio', () => ({
  addExpoTwoWayAudioEventListener: () => ({ remove: () => {} }),
  initialize: async () => {
    device.opens += 1
    return true
  },
  requestMicrophonePermissionsAsync: async () => ({ granted: true }),
  tearDown: () => {},
  toggleRecording: (recording: boolean) => {
    device.recording = recording
    return true
  }
}))
vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: async () => {},
  deactivateKeepAwake: async () => {}
}))
vi.mock('expo-router', () => ({ useFocusEffect: () => {} }))
vi.mock('../platform/haptics', () => ({ triggerError: () => {} }))
vi.mock('./use-mobile-native-chat-readability', () => ({
  useMobileNativeChatReadability: () => true
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
vi.mock('./use-mobile-session-view-mode', () => ({
  useMobileSessionViewMode: () => ({
    ready: true,
    isTabChatView: () => false,
    setTabView: () => {},
    toggleTabChatView: () => {}
  })
}))
vi.mock('./use-mobile-native-chat-controller', async () => {
  const { useMobileNativeChatActiveResolution } =
    await import('./use-mobile-native-chat-active-resolution')
  return {
    useMobileNativeChatController: (
      args: Parameters<typeof useMobileNativeChatActiveResolution>[0]
    ) => {
      const resolution = useMobileNativeChatActiveResolution(args)
      const [chatComposerText, setChatComposerText] = useState('Draft')
      return {
        ...resolution,
        nativeChatSession: { messages: [] },
        nativeChatCommandRefusalCauses: null,
        chatComposerText,
        setChatComposerText
      }
    }
  }
})
vi.mock('./use-mobile-send-completion-generation', () => ({
  useMobileSendCompletionGeneration: () => () => 0
}))

import { useMobileSessionNativeChatDictation } from './use-mobile-session-native-chat-dictation'

type SessionScope = Pick<
  MobileSessionFeedbackCapabilitiesModel,
  | 'hostId'
  | 'worktreeId'
  | 'client'
  | 'connState'
  | 'agentSessionHostSupport'
  | 'setInput'
  | 'liveInputTerminalHandles'
  | 'activeHandle'
  | 'activeSessionTabId'
  | 'activeSessionTab'
  | 'diffComments'
  | 'diffCommentsRef'
  | 'setShowDictationSetup'
  | 'setDictationMode'
  | 'dictationEnabled'
  | 'setDictationEnabled'
  | 'deviceTokenRef'
  | 'dictationRouteContextRef'
  | 'activeHandleRef'
  | 'flushPendingLiveInputBeforeExternalSend'
  | 'canSend'
  | 'liveInputEnabled'
  | 'showToast'
  | 'resetLiveInputFocus'
>
type ProbeOptions = {
  client: FakeRpcClient
  tab: MobileSessionTab
  connState: ConnectionState
  dictationEnabled: boolean
}

const agentTab: MobileSessionTab = {
  id: 'chat1',
  title: 'Chat',
  type: 'agent-session',
  sessionId: 'session1',
  agent: 'claude',
  isActive: true
}
const terminalTab: MobileSessionTab = {
  id: 'term1',
  title: 'Terminal',
  type: 'terminal',
  terminal: 't1',
  isActive: true
}
let renderer: ReactTestRenderer | null = null
let current: ReturnType<typeof useMobileSessionNativeChatDictation> | null = null
let terminalText = ''

function Probe({ client, tab, connState, dictationEnabled }: ProbeOptions): null {
  const activeHandle = tab.type === 'terminal' ? tab.terminal : null
  const activeHandleRef = useRef(activeHandle)
  const scope: SessionScope = {
    hostId: 'h1',
    worktreeId: 'w1',
    client,
    connState,
    agentSessionHostSupport: structuredAgentSessionHostSupport([]),
    setInput: (next) => {
      terminalText = typeof next === 'function' ? next(terminalText) : next
    },
    liveInputTerminalHandles: new Set<string>(),
    activeHandle,
    activeSessionTabId: tab.id,
    activeSessionTab: tab,
    diffComments: [],
    diffCommentsRef: useRef([]),
    setShowDictationSetup: () => {},
    setDictationMode: () => {},
    dictationEnabled,
    setDictationEnabled: () => {},
    deviceTokenRef: useRef('dev'),
    dictationRouteContextRef: useRef(null),
    activeHandleRef,
    flushPendingLiveInputBeforeExternalSend: async () => true,
    canSend: resolveMobileTerminalInputGate({
      connState,
      activeHandle,
      activeSessionTabType: tab.type
    }).canSend,
    liveInputEnabled: false,
    showToast: () => {},
    resetLiveInputFocus: () => {}
  }
  current = useMobileSessionNativeChatDictation(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SessionScope checks every consumed field; the remaining session subsystems are unused by this hook.
    scope as MobileSessionFeedbackCapabilitiesModel,
    async () => true
  )
  return null
}

function model(): NonNullable<typeof current> {
  if (!current) {
    throw new Error('Probe has not mounted')
  }
  return current
}

async function render(options: ProbeOptions): Promise<void> {
  await act(async () => {
    const probe = createElement(Probe, options)
    if (renderer) {
      renderer.update(probe)
    } else {
      renderer = create(probe)
    }
  })
}

async function reply(rpc: FakeRpcClient, method: string, result: unknown): Promise<SentRequest> {
  await act(async () => {})
  const request = rpc.requests.shift()
  if (!request) {
    throw new Error(`No request for ${method}`)
  }
  expect(request.method).toBe(method)
  await act(async () => request.resolve({ id: 'desktop', ok: true, result }))
  return request
}

async function start(rpc: FakeRpcClient): Promise<void> {
  await act(async () => model().startDictation())
  await reply(rpc, 'speech.dictation.start', { started: true })
  expect(model().dictation.status).toBe('recording')
  expect(device.recording).toBe(true)
}

beforeEach(() => {
  current = null
  device.opens = 0
  device.recording = false
  terminalText = ''
})
afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = null
})

describe('dictation uses the active composer readiness', () => {
  it('records without a terminal and appends the transcript to the agent chat draft', async () => {
    const client = createFakeRpcClient()
    await render({ client, tab: agentTab, connState: 'connected', dictationEnabled: true })
    await start(client)
    await act(async () => {
      void model().dictation.stop()
    })
    await reply(client, 'speech.dictation.finish', { text: 'spoken words' })
    expect(model().nativeChatController.chatComposerText).toBe('Draft spoken words')
    expect(terminalText).toBe('')
    expect(model().dictation.status).toBe('idle')
    expect(device.recording).toBe(false)
  })

  it.each([
    { name: 'disconnected chat', tab: agentTab, connState: 'disconnected', dictationEnabled: true },
    { name: 'disabled chat', tab: agentTab, connState: 'connected', dictationEnabled: false },
    {
      name: 'terminal without a handle',
      tab: { ...terminalTab, terminal: null },
      connState: 'connected',
      dictationEnabled: true
    }
  ] satisfies (Omit<ProbeOptions, 'client'> & { name: string })[])(
    'does not open the mic for $name',
    async (options) => {
      const client = createFakeRpcClient()
      await render({ ...options, client })
      await act(async () => model().startDictation())
      expect(device.opens).toBe(0)
      expect(client.requests).toEqual([])
      expect(model().dictation.status).toBe('idle')
    }
  )

  it('keeps buffered terminal dictation working', async () => {
    const client = createFakeRpcClient()
    await render({ client, tab: terminalTab, connState: 'connected', dictationEnabled: true })
    await start(client)
    await act(async () => {
      void model().dictation.stop()
    })
    await reply(client, 'speech.dictation.finish', { text: 'terminal words' })
    expect(terminalText).toBe('terminal words')
    expect(model().nativeChatController.chatComposerText).toBe('Draft')
  })

  it('cancels an in-flight agent-chat start when the connection drops', async () => {
    const client = createFakeRpcClient()
    const options = {
      client,
      tab: agentTab,
      connState: 'connected',
      dictationEnabled: true
    } satisfies ProbeOptions
    await render(options)
    await act(async () => model().startDictation())
    const pendingStart = client.requests.shift()
    expect(pendingStart?.method).toBe('speech.dictation.start')
    await render({ ...options, connState: 'disconnected' })
    await reply(client, 'speech.dictation.cancel', {})
    await act(async () =>
      pendingStart?.resolve({ id: 'desktop', ok: true, result: { started: true } })
    )
    await reply(client, 'speech.dictation.cancel', {})
    expect(device.recording).toBe(false)
    expect(model().nativeChatController.chatComposerText).toBe('Draft')
    await render(options)
    await start(client)
  })

  it('drops a late transcript after disconnecting, then starts again on reconnect', async () => {
    const client = createFakeRpcClient()
    const options = {
      client,
      tab: agentTab,
      connState: 'connected',
      dictationEnabled: true
    } satisfies ProbeOptions
    await render(options)
    await start(client)
    await act(async () => {
      void model().dictation.stop()
    })
    const pendingFinish = client.requests.shift()
    expect(pendingFinish?.method).toBe('speech.dictation.finish')
    await render({ ...options, connState: 'disconnected' })
    await reply(client, 'speech.dictation.cancel', {})
    await act(async () =>
      pendingFinish?.resolve({ id: 'desktop', ok: true, result: { text: 'late words' } })
    )
    expect(model().nativeChatController.chatComposerText).toBe('Draft')
    expect(device.recording).toBe(false)
    await render(options)
    await start(client)
  })
})
