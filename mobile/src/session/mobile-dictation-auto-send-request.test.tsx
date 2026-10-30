import { createElement, useRef } from 'react'
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
import {
  focusMobileNativeChatTextDestination,
  registerMobileNativeChatTextDestination
} from './native-chat/composer/mobile-native-chat-draft-inputs'

type ScreenLifecycle = {
  appStateListeners: Set<(state: string) => void>
  focusCleanups: Set<() => void>
  chatViewTabs: Set<string>
}
const draft = vi.hoisted(() => ({ text: 'Draft' }))
const lifecycle = vi.hoisted((): ScreenLifecycle => ({
  appStateListeners: new Set(),
  focusCleanups: new Set(),
  chatViewTabs: new Set()
}))
const microphone = vi.hoisted(() => new Set<(event: { data: Uint8Array }) => void>())
const setAppState = (state: string): void => lifecycle.appStateListeners.forEach((l) => l(state))
const blurScreen = (): void => lifecycle.focusCleanups.forEach((cleanup) => cleanup())

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      lifecycle.appStateListeners.add(listener)
      return { remove: () => lifecycle.appStateListeners.delete(listener) }
    }
  },
  Platform: { OS: 'ios' }
}))
vi.mock('@orca/expo-two-way-audio', () => ({
  addExpoTwoWayAudioEventListener: (
    event: string,
    listener: (event: { data: Uint8Array }) => void
  ) => {
    if (event !== 'onMicrophoneData') {
      return { remove: () => {} }
    }
    microphone.add(listener)
    return { remove: () => microphone.delete(listener) }
  },
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
// keeps its cleanups so a test can blur the screen.
vi.mock('expo-router', async () => {
  const React = await import('react')
  return {
    useFocusEffect: (effect: () => void | (() => void)) =>
      React.useEffect(() => {
        const cleanup = effect()
        const blur = (): void => cleanup?.()
        lifecycle.focusCleanups.add(blur)
        return () => {
          lifecycle.focusCleanups.delete(blur)
          blur()
        }
      }, [effect])
  }
})
vi.mock('../platform/haptics', () => ({
  triggerError: () => {},
  triggerEdgeBump: () => {},
  triggerSelection: () => {}
}))
vi.mock('../platform/clipboard', () => ({
  useClipboardWriter: () => ({ writeText: async () => {} })
}))
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
      return {
        ...resolution,
        nativeChatSession: { messages: [] },
        nativeChatCommandRefusalCauses: null,
        setChatComposerText: (update: string | ((current: string) => string)) => {
          draft.text = typeof update === 'function' ? update(draft.text) : update
        }
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
  | 'commandFieldAnchorRef'
  | 'activeHandleRef'
  | 'flushPendingLiveInputBeforeExternalSend'
  | 'canSend'
  | 'canCompose'
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
  const gate = resolveMobileTerminalInputGate({
    connState,
    activeHandle,
    activeSessionTabType: tab.type
  })
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
    commandFieldAnchorRef: useRef(null),
    activeHandleRef,
    flushPendingLiveInputBeforeExternalSend: async () => true,
    canSend: gate.canSend,
    canCompose: gate.canCompose,
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

function setupReply(setup: Record<string, unknown>): Record<string, unknown> {
  return { enabled: true, dictationMode: 'toggle', models: [], ...setup }
}

/** Mounts an agent chat and answers the setup read the focused screen makes. */
async function mountChat(
  setup: Record<string, unknown>,
  tab = agentTab('chat1')
): Promise<{ rpc: FakeRpcClient; options: ProbeOptions }> {
  const rpc = createFakeRpcClient()
  const options: ProbeOptions = { client: rpc, tab, connState: 'connected' }
  await render(options)
  await reply(rpc, 'speech.models.list', setupReply(setup))
  return { rpc, options }
}

/** Records, stops, and leaves the finish unanswered so the transcript can arrive later. */
async function recordAndStop(rpc: FakeRpcClient, wordsSoFar?: string): Promise<SentRequest> {
  await act(async () => model().startDictation())
  await reply(rpc, 'speech.dictation.start', { started: true })
  if (wordsSoFar !== undefined) {
    act(() => microphone.forEach((listener) => listener({ data: Uint8Array.from([1, 2]) })))
    await reply(rpc, 'speech.dictation.chunk', { text: wordsSoFar })
  }
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
  draft.text = 'Draft'
  current = null
  lifecycle.appStateListeners.clear()
  lifecycle.focusCleanups.clear()
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

    expect(draft.text).toBe('Draft spoken words')
    expect(model().dictationAutoSend.getSnapshot()).toMatchObject({ delayMs: 3000 })
  })

  it('appends the transcript without a countdown for a desktop that predates the setting', async () => {
    const { rpc } = await mountChat({})
    await deliver(await recordAndStop(rpc), 'spoken words')

    expect(draft.text).toBe('Draft spoken words')
    expect(model().dictationAutoSend.getSnapshot()).toBeNull()
  })

  it('keeps the words a failed dictation saved as a draft', async () => {
    const { rpc } = await mountChat(SETTING_ON)
    const finish = await recordAndStop(rpc, 'partial words')

    await act(async () => finish.reject(new Error('Connection lost')))

    expect(draft.text).toBe('Draft partial words')
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
    ['the app goes to the background', () => setAppState('background')],
    ['the screen loses focus', blurScreen]
  ])('keeps a transcript that arrives after %s as a draft', async (_name, leave) => {
    const { rpc } = await mountChat(SETTING_ON)
    const finish = await recordAndStop(rpc)

    act(() => leave())
    await deliver(finish, 'late words')

    expect(draft.text).toBe('Draft late words')
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
    expect(draft.text).toBe('Draft spoken words')
  })

  it('never auto-sends a dictation into a queued-message edit', async () => {
    const edit: string[] = []
    const release = registerMobileNativeChatTextDestination('queued-edit:1', () => ({
      scope: 'queued-edit:1',
      anchor: null,
      insert: (text) => {
        edit.push(text)
      }
    }))
    focusMobileNativeChatTextDestination('queued-edit:1')
    try {
      const { rpc } = await mountChat(SETTING_ON)
      await deliver(await recordAndStop(rpc), 'edit words')

      expect(edit).toEqual(['edit words'])
      expect(model().dictationAutoSend.getSnapshot()).toBeNull()
    } finally {
      release()
    }
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

    expect(draft.text).toBe('Draft late words')
    expect(model().dictationAutoSend.getSnapshot()).toBeNull()
  })

  it('starts the next countdown after one was kept as a draft', async () => {
    const { rpc } = await mountChat(SETTING_ON)
    const finish = await recordAndStop(rpc)
    act(() => setAppState('background'))
    await deliver(finish, 'kept')
    expect(model().dictationAutoSend.getSnapshot()).toBeNull()

    act(() => setAppState('active'))
    await reply(rpc, 'speech.models.list', setupReply(SETTING_ON))
    await deliver(await recordAndStop(rpc), 'sent')

    expect(draft.text).toBe('Draft kept sent')
    expect(model().dictationAutoSend.getSnapshot()).toMatchObject({ delayMs: 3000 })
  })
})
