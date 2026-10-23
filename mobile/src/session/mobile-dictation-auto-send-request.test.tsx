/**
 * The session's half of "Send when dictation ends": a chat transcript starts the countdown only
 * when the desktop's setup reply turned the setting on; dictating again, a dropped connection, or
 * leaving the screen, the app or the chat cancels it; and the next dictation still sends.
 *
 * Mounts the real `useMobileSessionNativeChatDictation` over the real `useMobileDictation`, with the
 * real chat resolution deciding chat versus terminal and a desktop that answers each request in turn.
 */
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

type ScreenLifecycle = {
  appStateListener: ((state: string) => void) | null
  blur: (() => void) | null
  chatViewTabs: Set<string>
}
const lifecycle = vi.hoisted((): ScreenLifecycle => ({
  appStateListener: null,
  blur: null,
  chatViewTabs: new Set()
}))

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      lifecycle.appStateListener = listener
      return { remove: () => {} }
    }
  },
  Platform: { OS: 'ios' }
}))
vi.mock('@orca/expo-two-way-audio', () => ({
  addExpoTwoWayAudioEventListener: () => ({ remove: () => {} }),
  initialize: async () => true,
  requestMicrophonePermissionsAsync: async () => ({ granted: true }),
  tearDown: () => {},
  toggleRecording: () => true
}))
vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: async () => {},
  deactivateKeepAwake: async () => {}
}))
// Runs the focus effect like a focused screen, so the hook reads the desktop's setup on mount, and
// keeps its cleanup so a test can blur the screen.
vi.mock('expo-router', async () => {
  const React = await import('react')
  return {
    useFocusEffect: (effect: () => void | (() => void)) =>
      React.useEffect(() => {
        const cleanup = effect()
        lifecycle.blur = () => cleanup?.()
        return cleanup
      }, [effect])
  }
})
vi.mock('../platform/haptics', () => ({ triggerError: () => {} }))
vi.mock('./use-mobile-native-chat-readability', () => ({
  useMobileNativeChatReadability: () => true
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
vi.mock('./use-mobile-session-view-mode', () => ({
  useMobileSessionViewMode: () => ({
    ready: true,
    isTabChatView: (tabId: string) => lifecycle.chatViewTabs.has(tabId),
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
type ProbeOptions = { client: FakeRpcClient; tab: MobileSessionTab; connState: ConnectionState }

function agentTab(id: string): MobileSessionTab {
  return {
    id,
    title: 'Chat',
    type: 'agent-session',
    sessionId: `session-${id}`,
    agent: 'claude',
    isActive: true
  }
}

/** A terminal running a chat-capable agent, so its view can switch between terminal and chat. */
const terminalTab: MobileSessionTab = {
  id: 'term1',
  title: 'Terminal',
  type: 'terminal',
  terminal: 't1',
  launchAgent: 'claude',
  isActive: true
}

// Stable like the screen's useState setters, so the focus effect does not rerun on every render.
const noop = (): void => {}
let renderer: ReactTestRenderer | null = null
let current: ReturnType<typeof useMobileSessionNativeChatDictation> | null = null

function Probe({ client, tab, connState }: ProbeOptions): null {
  const activeHandle = tab.type === 'terminal' ? tab.terminal : null
  const activeHandleRef = useRef(activeHandle)
  const scope: SessionScope = {
    hostId: 'h1',
    worktreeId: 'w1',
    client,
    connState,
    agentSessionHostSupport: structuredAgentSessionHostSupport([]),
    setInput: noop,
    liveInputTerminalHandles: new Set<string>(),
    activeHandle,
    activeSessionTabId: tab.id,
    activeSessionTab: tab,
    diffComments: [],
    diffCommentsRef: useRef([]),
    setShowDictationSetup: noop,
    setDictationMode: noop,
    dictationEnabled: true,
    setDictationEnabled: noop,
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
    showToast: noop,
    resetLiveInputFocus: noop
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

/** Answers the next request, which must be `method`. */
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

const SETTING_ON = { autoSendAfterDictation: true, autoSendDelayMs: 3000 }

/** Mounts an agent chat and answers the setup read the focused screen makes. */
async function mountChat(
  setup: Record<string, unknown>,
  tab = agentTab('chat1')
): Promise<{ rpc: FakeRpcClient; options: ProbeOptions }> {
  const rpc = createFakeRpcClient()
  const options: ProbeOptions = { client: rpc, tab, connState: 'connected' }
  await render(options)
  await reply(rpc, 'speech.models.list', {
    enabled: true,
    dictationMode: 'toggle',
    models: [],
    ...setup
  })
  return { rpc, options }
}

/** Records, stops, and leaves the finish unanswered so the transcript can arrive later. */
async function recordAndStop(rpc: FakeRpcClient): Promise<SentRequest> {
  await act(async () => model().startDictation())
  await reply(rpc, 'speech.dictation.start', { started: true })
  await act(async () => {
    void model().dictation.stop()
  })
  await act(async () => {})
  const finish = rpc.requests.shift()
  if (!finish) {
    throw new Error('No request for speech.dictation.finish')
  }
  expect(finish.method).toBe('speech.dictation.finish')
  return finish
}

async function deliver(finish: SentRequest, text: string): Promise<void> {
  await act(async () => finish.resolve({ id: 'desktop', ok: true, result: { text } }))
}

beforeEach(() => {
  current = null
  lifecycle.appStateListener = null
  lifecycle.blur = null
  lifecycle.chatViewTabs.clear()
})
afterEach(async () => {
  current?.dictationAutoSend.withdraw()
  await act(async () => renderer?.unmount())
  renderer = null
})

describe('a chat transcript and the desktop auto-send setting', () => {
  it('appends the transcript and starts a countdown with the desktop delay', async () => {
    const { rpc } = await mountChat(SETTING_ON)
    await deliver(await recordAndStop(rpc), 'spoken words')

    expect(model().nativeChatController.chatComposerText).toBe('Draft spoken words')
    expect(model().dictationAutoSend.getSnapshot()).toMatchObject({ delayMs: 3000 })
  })

  it('appends the transcript without a countdown for a desktop that predates the setting', async () => {
    const { rpc } = await mountChat({})
    await deliver(await recordAndStop(rpc), 'spoken words')

    expect(model().nativeChatController.chatComposerText).toBe('Draft spoken words')
    expect(model().dictationAutoSend.getSnapshot()).toBeNull()
  })

  it('cancels the countdown when the user starts dictating again', async () => {
    const { rpc } = await mountChat(SETTING_ON)
    await deliver(await recordAndStop(rpc), 'spoken words')

    await act(async () => model().startDictation())
    expect(model().dictationAutoSend.getSnapshot()).toBeNull()
    await reply(rpc, 'speech.dictation.start', { started: true })
  })

  it.each([
    ['the app goes to the background', () => lifecycle.appStateListener?.('background')],
    ['the screen loses focus', () => lifecycle.blur?.()]
  ])('keeps a transcript that arrives after %s as a draft', async (_name, leave) => {
    const { rpc } = await mountChat(SETTING_ON)
    const finish = await recordAndStop(rpc)

    act(() => leave())
    await deliver(finish, 'late words')

    expect(model().nativeChatController.chatComposerText).toBe('Draft late words')
    expect(model().dictationAutoSend.getSnapshot()).toBeNull()
  })

  it('does not send a transcript that arrives after the user switched chats', async () => {
    const { rpc, options } = await mountChat(SETTING_ON)
    const finish = await recordAndStop(rpc)

    await render({ ...options, tab: agentTab('chat2') })
    await deliver(finish, 'late words')

    expect(model().dictationAutoSend.getSnapshot()).toBeNull()
  })

  it('drops a running countdown when the connection drops, and a reconnect does not resume it', async () => {
    const { rpc, options } = await mountChat(SETTING_ON)
    await deliver(await recordAndStop(rpc), 'spoken words')
    expect(model().dictationAutoSend.getSnapshot()).not.toBeNull()

    await render({ ...options, connState: 'disconnected' })
    expect(model().dictationAutoSend.getSnapshot()).toBeNull()

    await render(options)
    expect(model().dictationAutoSend.getSnapshot()).toBeNull()
    expect(model().nativeChatController.chatComposerText).toBe('Draft spoken words')
  })

  it('never auto-sends a dictation started in terminal view, even if the tab switches to chat', async () => {
    const { rpc, options } = await mountChat(SETTING_ON, terminalTab)
    expect(model().nativeChatController.showNativeChat).toBe(false)
    const finish = await recordAndStop(rpc)

    lifecycle.chatViewTabs.add(terminalTab.id)
    await render(options)
    expect(model().nativeChatController.showNativeChat).toBe(true)
    await deliver(finish, 'terminal words')

    expect(model().dictationAutoSend.getSnapshot()).toBeNull()
  })

  it('withdraws when the tab leaves chat view while the transcript is on its way', async () => {
    lifecycle.chatViewTabs.add(terminalTab.id)
    const { rpc, options } = await mountChat(SETTING_ON, terminalTab)
    expect(model().nativeChatController.showNativeChat).toBe(true)
    const finish = await recordAndStop(rpc)

    lifecycle.chatViewTabs.delete(terminalTab.id)
    await render(options)
    lifecycle.chatViewTabs.add(terminalTab.id)
    await render(options)
    await deliver(finish, 'late words')

    expect(model().nativeChatController.chatComposerText).toBe('Draft late words')
    expect(model().dictationAutoSend.getSnapshot()).toBeNull()
  })

  it('auto-sends the next dictation after one was kept as a draft', async () => {
    const { rpc } = await mountChat(SETTING_ON)
    const finish = await recordAndStop(rpc)
    act(() => lifecycle.appStateListener?.('background'))
    await deliver(finish, 'kept')
    expect(model().dictationAutoSend.getSnapshot()).toBeNull()

    await deliver(await recordAndStop(rpc), 'sent')

    expect(model().nativeChatController.chatComposerText).toBe('Draft kept sent')
    expect(model().dictationAutoSend.getSnapshot()).toMatchObject({ delayMs: 3000 })
  })
})
