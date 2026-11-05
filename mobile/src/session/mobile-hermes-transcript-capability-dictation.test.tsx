import { createElement, useRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeRpcClient, type FakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import { resolveMobileTerminalInputGate } from '../terminal/terminal-input-connection-gate'
import type { MobileSessionFeedbackCapabilitiesModel } from './use-mobile-session-feedback-capabilities'
import type { MobileSessionTab } from './mobile-session-route-types'
import type { ConnectionState } from '../transport/types'
import { structuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'
import { HERMES_TRANSCRIPT_RUNTIME_CAPABILITY } from '../../../src/shared/native-chat/native-chat-hermes-capability'

const device = vi.hoisted(() => ({ chatView: false }))
vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
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
vi.mock('../platform/clipboard', () => ({
  useClipboardWriter: () => ({ writeText: async () => {} })
}))
vi.mock('expo-router', () => ({ useFocusEffect: () => {} }))
vi.mock('../platform/haptics', () => ({
  triggerError: () => {},
  triggerEdgeBump: () => {},
  triggerSelection: () => {}
}))
vi.mock('./native-chat/transcript/use-mobile-native-chat-readability', () => ({
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
    isTabChatView: () => device.chatView,
    setTabView: () => {},
    toggleTabChatView: () => {}
  })
}))
vi.mock('./native-chat/use-mobile-native-chat-controller', async () => {
  const { useMobileNativeChatActiveResolution } =
    await import('./native-chat/use-mobile-native-chat-active-resolution')
  return {
    useMobileNativeChatController: (
      args: Parameters<typeof useMobileNativeChatActiveResolution>[0]
    ) => {
      const resolution = useMobileNativeChatActiveResolution(args)
      return {
        ...resolution,
        nativeChatSession: { messages: [] },
        nativeChatCommandRefusalCauses: null,
        setChatComposerText: () => {}
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
  | 'pairedHostClient'
  | 'connState'
  | 'agentSessionHostSupport'
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
  | 'canCompose'
  | 'showToast'
  | 'resetLiveInputFocus'
  | 'hostCapabilities'
>
type ProbeOptions = {
  client: FakeRpcClient
  tab: MobileSessionTab
  connState: ConnectionState
  dictationEnabled: boolean
  hostCapabilities?: string[]
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

function Probe({ client, tab, connState, dictationEnabled, hostCapabilities }: ProbeOptions): null {
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
    pairedHostClient: client,
    connState,
    agentSessionHostSupport: structuredAgentSessionHostSupport([]),
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
    canSend: gate.canSend,
    canCompose: gate.canCompose,
    showToast: () => {},
    resetLiveInputFocus: () => {},
    hostCapabilities: hostCapabilities ?? []
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

beforeEach(() => {
  current = null
  device.chatView = false
})
afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = null
})

describe('Hermes chat stays gated on the host transcript capability', () => {
  it('opens Hermes chat only when the host can serve its transcript', async () => {
    const client = createFakeRpcClient()
    const tab = { ...terminalTab, launchAgent: 'hermes' as const }
    device.chatView = true
    await render({ client, tab, connState: 'connected', dictationEnabled: false })
    expect(model().showNativeChat).toBe(false)
    await render({
      client,
      tab,
      connState: 'connected',
      dictationEnabled: false,
      hostCapabilities: [HERMES_TRANSCRIPT_RUNTIME_CAPABILITY]
    })
    expect(model().showNativeChat).toBe(true)
  })
})
