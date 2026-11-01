import { mobileNativeChatDraftDestination } from './native-chat/composer/mobile-native-chat-draft-inputs'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionOptionDescriptor } from '../../../src/shared/native-chat/input/native-chat-session-options'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type { MobileNativeChatPrompts } from './native-chat/input/use-mobile-native-chat-prompts'

const acceptSend = vi.fn()
const captureSendOrigin = vi.fn()
const clearDraftForSend = vi.fn()
const restoreRejectedDraft = vi.fn()
const holdUnconfirmedSend = vi.fn()

const viewMode = { isTabChatView: (_tabId: string) => true }
let draftPending: { id: string }[] = []
const sessionState = { messages: [] as unknown[], status: 'ready', transcriptLoading: false }
const structuredSendWithOutcome = vi.fn()
const structuredCancel = vi.fn()
const structuredCancelPrompt = vi.fn(async () => true)
const structuredRespondPermission = vi.fn(async () => true)
const structuredRespondQuestion = vi.fn(async () => true)
const structuredSetOption = vi.fn(async () => true)
const structuredInvokeOption = vi.fn(async () => true)
const structuredOptionSnapshot: SessionOptionDescriptor[] = [
  {
    id: 'model',
    label: 'Model',
    category: 'model',
    kind: {
      type: 'select',
      currentValue: 'gpt-fast',
      choices: [{ value: 'gpt-fast', label: 'GPT Fast' }]
    },
    valueSource: 'reported',
    transport: 'agent-session',
    settable: true
  }
]
const structuredOptionSurface = {
  getSnapshot: () => structuredOptionSnapshot,
  setOption: async () => ({ snapshot: structuredOptionSnapshot }),
  invokeAction: async () => ({ snapshot: structuredOptionSnapshot }),
  subscribe: () => () => {}
}
const structuredPermission = {
  title: 'Allow Bash?',
  detail: 'rm -rf build',
  options: [
    { label: 'Allow once', send: 'allow-once' },
    { label: 'Deny', send: 'deny' }
  ]
}
const structuredQuestion = {
  question: 'Pick destination',
  options: ['Choice A', 'Choice B'],
  allowOther: true,
  optionTokens: ['choice-a', 'choice-b']
}
const structuredActivity = { isWorking: false, turnId: null as string | null }
let harnessHostSupport: ReturnType<typeof structuredAgentSessionHostSupport> | null = null
const structuredSessionState = {
  messages: [] as unknown[],
  status: 'ready',
  transcriptLoading: false,
  error: undefined,
  hasMore: false,
  loadingEarlier: false,
  loadEarlier: vi.fn()
}
const promptsState: Pick<MobileNativeChatPrompts, 'permission' | 'ask' | 'waitStartedAt'> = {
  permission: null,
  ask: null,
  waitStartedAt: null
}

// Isolate send outcomes and draft accounting by stubbing unrelated controller hooks.
vi.mock('./use-mobile-session-view-mode', () => ({
  useMobileSessionViewMode: () => ({
    isTabChatView: (tabId: string) => viewMode.isTabChatView(tabId),
    setTabView: vi.fn(),
    toggleTabChatView: vi.fn()
  })
}))
vi.mock('./use-mobile-structured-session-commands', () => ({
  useMobileStructuredSessionCommands: () => ({ commands: undefined, refresh: vi.fn() })
}))
vi.mock('./use-mobile-native-chat-session', () => ({
  useMobileNativeChatSession: () => sessionState
}))
vi.mock('./use-mobile-structured-agent-session', () => ({
  useMobileStructuredAgentSession: () => ({
    asyncQuestionSourceScope: 'journal/host/session/epoch',
    session: structuredSessionState,
    ...structuredActivity,
    queued: { cards: [], send: vi.fn(), delete: vi.fn(), edit: vi.fn() },
    sendWithOutcome: structuredSendWithOutcome,
    acceptsImages: false,
    cancel: structuredCancel,
    cancelPrompt: structuredCancelPrompt,
    permission: structuredPermission,
    question: structuredQuestion,
    optionSnapshot: structuredOptionSnapshot,
    optionSurface: structuredOptionSurface,
    pendingOptionId: 'model',
    respondPermission: structuredRespondPermission,
    respondQuestion: structuredRespondQuestion,
    setStructuredOption: structuredSetOption,
    invokeStructuredOption: structuredInvokeOption
  })
}))
vi.mock('./native-chat/composer/use-mobile-native-chat-drafts', () => ({
  useMobileNativeChatDrafts: () => {
    return {
      draftKey: null,
      setComposerText: vi.fn(),
      pending: draftPending,
      imagePreviewsByMessageId: {},
      captureSendOrigin,
      readSeededLaunchDraft: () => null,
      readSeededLaunchDraftSeed: () => null,
      clearDraftForSend,
      restoreRejectedDraft,
      acceptSend,
      holdUnconfirmedSend
    }
  }
}))
vi.mock('./native-chat/input/use-mobile-native-chat-prompts', () => ({
  useMobileNativeChatPrompts: () => promptsState
}))
const answerSendArgs: { streamIdentity?: string }[] = []
vi.mock('./native-chat/input/use-mobile-native-chat-answer-send', () => ({
  useMobileNativeChatAnswerSend: (args: { streamIdentity?: string }) => {
    answerSendArgs.push(args)
    return { answerAsk: vi.fn(), cancelPending: vi.fn() }
  }
}))
vi.mock('./native-chat/input/mobile-native-chat-permission-send', () => ({
  useMobileNativeChatPermissionSend: () => vi.fn()
}))
const terminalStop = vi.fn(async () => true)
vi.mock('./use-mobile-native-chat-stop', () => ({
  useMobileNativeChatStop: () => terminalStop
}))
vi.mock('./native-chat/composer/use-mobile-native-chat-file-search', () => ({
  useMobileNativeChatFileSearch: () => ({ nativeChatFilePaths: [], loadNativeChatFiles: vi.fn() })
}))
// Keep the real timeout constant available to stale-input heal through the partial send mock.
vi.mock('./native-chat/mobile-native-chat-send', async (importOriginal) => ({
  ...(await importOriginal<typeof NativeChatSend>()),
  sendMobileNativeChatMessageWithOutcome: vi.fn()
}))

import * as NativeChatSend from './native-chat/mobile-native-chat-send'
import {
  isMobileNativeChatInputStale,
  markMobileNativeChatInputStale,
  resetMobileNativeChatStaleInputForTests
} from './native-chat/mobile-native-chat-stale-input'
import { useMobileNativeChatController } from './use-mobile-native-chat-controller'
import type { MobileNativeChatController } from './mobile-native-chat-controller-contract'
import type { MobileNativeChatStatus } from './use-mobile-native-chat-session'
import { mobileNativeChatPromptDismissals } from './native-chat/input/mobile-native-chat-prompt-dismissals'
import { structuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'

const sendWithOutcome = vi.mocked(NativeChatSend.sendMobileNativeChatMessageWithOutcome)

const ORIGIN = {
  draftKey: 'h\0w\0tab-1',
  draftDestination: mobileNativeChatDraftDestination('h\0w\0tab-1'),
  draftEditGeneration: 0,
  pendingKey: 'h\0w\0tab-1\0session-1',
  normalizedText: 'look',
  boundary: { afterMessageId: null },
  sentAt: 0
}

function structuredTab(agent: string) {
  const tab = {
    type: 'agent-session',
    id: 'agent-tab-1',
    title: 'Chat',
    sessionId: 'session-structured',
    agent,
    isActive: true
  }
  return { tab, activeHandle: null, inputLeaseReady: false }
}

describe('useMobileNativeChatController handleNativeChatSend', () => {
  let renderer: ReactTestRenderer | null = null
  let controller: MobileNativeChatController | null = null
  const onSendError = vi.fn()
  const onSendResolved = vi.fn()
  const clientStub = { sendRequest: vi.fn() }

  function Harness({
    connState = 'connected',
    tab = null,
    activeHandle = 'term-1',
    inputLeaseReady = true
  }: {
    connState?: ConnectionState
    tab?: unknown
    activeHandle?: string | null
    inputLeaseReady?: boolean
  }): null {
    controller = useMobileNativeChatController({
      client: clientStub as unknown as RpcClient,
      connState,
      hostId: 'h',
      worktreeId: 'w',
      activeSessionTab: tab as never,
      activeSessionTabId: (tab as { id?: string } | null)?.id ?? 'tab-1',
      activeHandleRef: { current: activeHandle },
      deviceTokenRef: { current: null },
      nativeChatTranscriptIsLocalReadable: true,
      nativeChatInputLeaseReady: inputLeaseReady,
      agentSessionHostSupport: harnessHostSupport,
      onSendError,
      onSendResolved
    })
    return null
  }

  beforeEach(() => {
    vi.clearAllMocks()
    clientStub.sendRequest.mockResolvedValue({
      id: 'send',
      ok: true,
      result: { send: { accepted: true } },
      _meta: { runtimeId: 'r' }
    })
    resetMobileNativeChatStaleInputForTests()
    captureSendOrigin.mockReturnValue(ORIGIN)
    structuredSendWithOutcome.mockResolvedValue('accepted')
    act(() => {
      renderer = create(createElement(Harness))
    })
  })
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    controller = null
  })

  it('clears an orphaned image paste before a question-card answer (#10228)', async () => {
    markMobileNativeChatInputStale('term-1')
    clientStub.sendRequest.mockResolvedValue({
      id: 'send',
      ok: true,
      result: { send: { accepted: true } },
      _meta: { runtimeId: 'r' }
    })
    sendWithOutcome.mockResolvedValue('accepted')
    let accepted = false
    await act(async () => {
      accepted = await controller!.handleNativeChatSend('answer')
    })
    expect(accepted).toBe(true)
    expect(clientStub.sendRequest).toHaveBeenCalledTimes(2)
    for (const call of clientStub.sendRequest.mock.calls) {
      expect(call[1]).toMatchObject({ terminal: 'term-1', text: '\x15', enter: false })
    }
    expect(isMobileNativeChatInputStale('term-1')).toBe(false)
  })

  it('does not send when the healing clear is rejected, keeping the marker', async () => {
    markMobileNativeChatInputStale('term-1')
    clientStub.sendRequest.mockResolvedValue({
      id: 'send',
      ok: true,
      result: { send: { accepted: false } },
      _meta: { runtimeId: 'r' }
    })
    let accepted = true
    await act(async () => {
      accepted = await controller!.handleNativeChatSend('answer')
    })
    expect(accepted).toBe(false)
    expect(sendWithOutcome).not.toHaveBeenCalled()
    expect(onSendError).toHaveBeenCalledWith('Message not sent')
    expect(isMobileNativeChatInputStale('term-1')).toBe(true)
  })

  it('keeps the marker when Escape cancels an ask, which never submits the composer', async () => {
    markMobileNativeChatInputStale('term-1')
    sendWithOutcome.mockResolvedValue('accepted')
    let accepted = false
    await act(async () => {
      accepted = await controller!.handleNativeChatCancelAsk()
    })
    expect(accepted).toBe(true)
    // A swallowed but acknowledged clear would consume the marker without removing stale input.
    expect(clientStub.sendRequest).not.toHaveBeenCalled()
    expect(isMobileNativeChatInputStale('term-1')).toBe(true)
  })

  it('retires a held failure banner when a card action is accepted', async () => {
    // Accepted answers/permission replies must clear the route-owned send-error banner too.
    sendWithOutcome.mockResolvedValue('accepted')
    await act(async () => {
      await controller!.handleNativeChatCancelAsk()
    })
    expect(onSendResolved).toHaveBeenCalled()

    onSendResolved.mockClear()
    sendWithOutcome.mockResolvedValue('rejected')
    await act(async () => {
      await controller!.handleNativeChatCancelAsk()
    })
    expect(onSendResolved).not.toHaveBeenCalled()
  })

  it('routes structured agent-session sends away from terminal/nativeChat transports', async () => {
    await act(async () => {
      renderer?.update(createElement(Harness, structuredTab('codex')))
    })

    let accepted = false
    await act(async () => {
      accepted = await controller!.handleNativeChatSend('look')
    })

    expect(accepted).toBe(true)
    expect(structuredSendWithOutcome).toHaveBeenCalledWith(
      'look',
      undefined,
      undefined,
      undefined,
      []
    )
    expect(sendWithOutcome).not.toHaveBeenCalled()
    expect(clientStub.sendRequest).not.toHaveBeenCalled()
  })

  it("leaves a command the chat's own agent runs to its session, though Codex's host claims it", async () => {
    await act(async () => {
      renderer?.update(createElement(Harness, structuredTab('opencode')))
    })
    await act(async () => {
      await controller!.handleNativeChatSend('/review')
    })
    expect(structuredSendWithOutcome).toHaveBeenCalledWith(
      '/review',
      undefined,
      undefined,
      undefined,
      []
    )
    expect(acceptSend).not.toHaveBeenCalled()
    expect(restoreRejectedDraft).not.toHaveBeenCalled()
    expect(controller!.nativeChatAcceptsImages).toBe(false)
  })

  it('offers prompt Cancel only while a provider turn runs', async () => {
    const props = structuredTab('codex')
    structuredActivity.isWorking = true
    try {
      await act(async () => {
        renderer?.update(createElement(Harness, props))
      })
      expect(controller?.nativeChatTurnActive).toBe(true)
      expect(controller?.handleNativeChatCancelPrompt).toBeUndefined()
      structuredActivity.turnId = 'provider-turn'
      await act(async () => {
        renderer?.update(createElement(Harness, props))
      })
      expect(controller?.handleNativeChatCancelPrompt).toEqual(expect.any(Function))
      structuredActivity.turnId = null
      harnessHostSupport = structuredAgentSessionHostSupport(['agent-session.conversation-stop.v1'])
      await act(async () => renderer?.update(createElement(Harness, props)))
      expect(controller?.handleNativeChatCancelPrompt).toBeUndefined()
    } finally {
      harnessHostSupport = null
      structuredActivity.isWorking = false
      structuredActivity.turnId = null
    }
  })

  it('exposes structured prompt cards and session options on structured tabs', async () => {
    await act(async () => {
      renderer?.update(createElement(Harness, structuredTab('codex')))
    })

    expect(controller!.nativeChatPermission).toEqual(structuredPermission)
    expect(controller!.nativeChatQuestion).toEqual(structuredQuestion)
    expect(controller!.nativeChatSessionOptions).not.toBeNull()
    expect(controller!.nativeChatSessionOptions?.controller.snapshot).toEqual(
      structuredOptionSnapshot
    )

    await act(async () => {
      expect(await controller!.handleNativeChatRespondPermission('allow-once')).toBe(true)
    })
    expect(structuredRespondPermission).toHaveBeenCalledWith('allow-once')
    expect(sendWithOutcome).not.toHaveBeenCalled()

    await act(async () => {
      expect(await controller!.handleNativeChatQuestionAnswer?.('choice-a')).toBe(true)
    })
    expect(structuredRespondQuestion).toHaveBeenCalledWith('choice-a')
    expect(clientStub.sendRequest).not.toHaveBeenCalled()

    await act(async () => {
      expect(
        await controller!.nativeChatSessionOptions!.controller.setOption('model', 'gpt-fast')
      ).toBe(true)
    })
    expect(structuredSetOption).toHaveBeenCalledWith('model', 'gpt-fast')
  })

  it('pre-clears separately for a text-only send but never for an image send', async () => {
    // Image paste already cleared input; clearing again here would erase the photo before the text send.
    sendWithOutcome.mockResolvedValue('accepted')

    await act(async () => {
      await controller!.handleNativeChatSend('answer')
    })
    expect(clientStub.sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      expect.objectContaining({ text: '\x15', enter: false }),
      expect.any(Object)
    )
    expect(sendWithOutcome).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ clearInputFirst: expect.anything() })
    )

    clientStub.sendRequest.mockClear()

    await act(async () => {
      await controller!.handleNativeChatSend('look', ['file:///a.jpg'])
    })
    expect(clientStub.sendRequest).not.toHaveBeenCalled()
    expect(sendWithOutcome).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'look' }))
    expect(sendWithOutcome.mock.calls.at(-1)?.[0]).not.toHaveProperty('clearInputFirst')
  })

  it('holds an unknown-outcome send without posting the optimistic echo', async () => {
    sendWithOutcome.mockResolvedValue('unknown')
    let accepted = false
    await act(async () => {
      accepted = await controller!.handleNativeChatSend('look', ['file:///a.jpg'])
    })
    expect(accepted).toBe(true)
    expect(acceptSend).not.toHaveBeenCalled()
    expect(holdUnconfirmedSend).toHaveBeenCalledWith(ORIGIN, 'look', expect.any(Function))
    expect(clearDraftForSend).toHaveBeenCalledWith(ORIGIN, 'look')
    expect(restoreRejectedDraft).not.toHaveBeenCalled()
  })

  it('preserves the unknown outcome on the WithOutcome surface for paste-first callers', async () => {
    sendWithOutcome.mockResolvedValue('unknown')
    let outcome = 'accepted'
    await act(async () => {
      outcome = await controller!.handleNativeChatSendWithOutcome('look', ['file:///a.jpg'])
    })
    // Preserve unknown outcomes so image callers can heal potentially orphaned pastes.
    expect(outcome).toBe('unknown')
    expect(holdUnconfirmedSend).toHaveBeenCalledWith(ORIGIN, 'look', expect.any(Function))
  })

  it('fails a send fast while the socket is down, before spending the heal budget', async () => {
    // Gate on live connection immediately; lease state collapses one render later.
    markMobileNativeChatInputStale('term-1')
    await act(async () => {
      renderer?.update(createElement(Harness, { connState: 'connecting' }))
    })
    let accepted = true
    await act(async () => {
      accepted = await controller!.handleNativeChatSend('answer')
    })
    expect(accepted).toBe(false)
    expect(clientStub.sendRequest).not.toHaveBeenCalled()
    expect(sendWithOutcome).not.toHaveBeenCalled()
    expect(onSendError).toHaveBeenCalledWith('Message not sent (disconnected)')
  })

  it('reports a rejected send and posts no echo', async () => {
    sendWithOutcome.mockResolvedValue('rejected')
    let accepted = true
    await act(async () => {
      accepted = await controller!.handleNativeChatSend('look', ['file:///a.jpg'])
    })
    expect(accepted).toBe(false)
    expect(acceptSend).not.toHaveBeenCalled()
    expect(onSendError).toHaveBeenCalledWith('Message not sent')
    expect(restoreRejectedDraft).toHaveBeenCalledWith(ORIGIN, 'look')
  })
})

describe('useMobileNativeChatController ask dismissal across a transcript reload', () => {
  let renderer: ReactTestRenderer | null = null
  let controller: MobileNativeChatController | null = null
  const clientStub = { sendRequest: vi.fn() }
  const PROMPT = { questions: [{ question: 'Which path?', multiSelect: false, options: [] }] }

  const chatTab = { type: 'terminal', id: 'tab-1', launchAgent: 'claude' }
  // Allow tab/session changes mid-render to expose stale scope state.
  const activeTab = { id: 'tab-1', sessionId: 'session-1' }

  function Harness(): null {
    controller = useMobileNativeChatController({
      client: clientStub as unknown as RpcClient,
      connState: 'connected',
      hostId: 'h',
      worktreeId: 'w',
      activeSessionTab: {
        ...chatTab,
        id: activeTab.id,
        agentStatus: { agentType: 'claude', providerSession: { id: activeTab.sessionId } }
      } as never,
      activeSessionTabId: activeTab.id,
      activeHandleRef: { current: 'term-1' },
      deviceTokenRef: { current: null },
      nativeChatTranscriptIsLocalReadable: true,
      nativeChatInputLeaseReady: true,
      onSendError: vi.fn(),
      onSendResolved: vi.fn()
    })
    return null
  }

  function step(): void {
    act(() => {
      renderer?.update(createElement(Harness))
    })
  }

  // Couple transcript doubles as production does: loading withholds messages, while retained rows may survive a read failure.
  function setTranscript(status: MobileNativeChatStatus, rows = 1): void {
    sessionState.status = status
    sessionState.transcriptLoading = status === 'loading'
    sessionState.messages =
      status === 'ready' || status === 'error' ? Array.from({ length: rows }, () => ({})) : []
  }

  beforeEach(() => {
    mobileNativeChatPromptDismissals.clearForTests()
    viewMode.isTabChatView = () => true
    setTranscript('ready')
    promptsState.ask = PROMPT
    act(() => {
      renderer = create(createElement(Harness))
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    controller = null
    promptsState.ask = null
    setTranscript('ready', 0)
    viewMode.isTabChatView = () => true
    activeTab.id = 'tab-1'
    activeTab.sessionId = 'session-1'
  })

  it('scopes the dismissal to the tab it was taken on', () => {
    act(() => controller?.dismissNativeChatAsk())
    expect(controller?.nativeChatAsk).toBeNull()

    // Identical asks on different tabs are distinct occurrences.
    activeTab.id = 'tab-2'
    step()

    expect(controller?.nativeChatAsk).not.toBeNull()
  })

  it('shows a restarted session’s identical first question on the same tab', () => {
    // Provider-session changes within one tab must retire dismissal identity even when question text repeats.
    act(() => controller?.dismissNativeChatAsk())
    expect(controller?.nativeChatAsk).toBeNull()

    activeTab.sessionId = 'session-2'
    setTranscript('loading')
    promptsState.ask = null
    step()

    setTranscript('ready')
    promptsState.ask = PROMPT
    step()

    expect(controller?.nativeChatAsk).not.toBeNull()
  })

  it('keeps the dismissal while the re-subscribed transcript is still empty', () => {
    // Re-subscribing after a view toggle briefly hides transcript asks; that null must not retire their dismissals.
    expect(controller?.nativeChatAsk).not.toBeNull()
    act(() => controller?.dismissNativeChatAsk())
    expect(controller?.nativeChatAsk).toBeNull()

    viewMode.isTabChatView = () => false
    promptsState.ask = null
    step()

    viewMode.isTabChatView = () => true
    setTranscript('loading')
    step()

    setTranscript('ready')
    promptsState.ask = PROMPT
    step()

    expect(controller?.nativeChatAsk).toBeNull()
  })

  it('accepts an answer taken while the first transcript read is still in flight', () => {
    // A visible status ask remains observable before transcript arrival so answering it can still dismiss the card.
    act(() => renderer?.unmount())
    setTranscript('loading')
    act(() => {
      renderer = create(createElement(Harness))
    })

    expect(controller?.nativeChatAsk).not.toBeNull()
    act(() => controller?.dismissNativeChatAsk())

    expect(controller?.nativeChatAsk).toBeNull()
  })

  it('still retires the dismissal once a settled transcript reports no prompt', () => {
    act(() => controller?.dismissNativeChatAsk())
    expect(controller?.nativeChatAsk).toBeNull()

    promptsState.ask = null
    step()

    promptsState.ask = PROMPT
    step()

    expect(controller?.nativeChatAsk).not.toBeNull()
  })

  it('keeps the dismissal while a dropped client empties the transcript', () => {
    // Disconnected idle also withholds messages without loading; its null cannot prove the prompt cleared.
    act(() => controller?.dismissNativeChatAsk())
    expect(controller?.nativeChatAsk).toBeNull()

    setTranscript('idle')
    promptsState.ask = null
    step()

    setTranscript('ready')
    promptsState.ask = PROMPT
    step()

    expect(controller?.nativeChatAsk).toBeNull()
  })

  it('keeps the dismissal when the first read of a transcript errors', () => {
    // Initial-drain errors publish empty rows before later recovery; do not treat never-read emptiness as prompt clearance.
    act(() => controller?.dismissNativeChatAsk())
    expect(controller?.nativeChatAsk).toBeNull()

    setTranscript('error', 0)
    promptsState.ask = null
    step()

    setTranscript('ready')
    promptsState.ask = PROMPT
    step()

    expect(controller?.nativeChatAsk).toBeNull()
  })

  it('retires the dismissal when a failed read still reports the last transcript', () => {
    // Errors with retained history can still prove a prompt cleared; blanket error suppression would hide the next identical ask.
    act(() => controller?.dismissNativeChatAsk())
    expect(controller?.nativeChatAsk).toBeNull()

    setTranscript('error')
    promptsState.ask = null
    step()

    promptsState.ask = PROMPT
    step()

    expect(controller?.nativeChatAsk).not.toBeNull()
  })

  it('keeps the dismissal while the tab has no provider session yet', () => {
    // Waiting-session withholds messages without loading while launch identity can keep chat visible.
    act(() => controller?.dismissNativeChatAsk())
    expect(controller?.nativeChatAsk).toBeNull()

    setTranscript('waiting-session')
    promptsState.ask = null
    step()

    setTranscript('ready')
    promptsState.ask = PROMPT
    step()

    expect(controller?.nativeChatAsk).toBeNull()
  })
})

describe('useMobileNativeChatController terminal turn', () => {
  let renderer: ReactTestRenderer | null = null
  let controller: MobileNativeChatController | null = null
  const clientStub = { sendRequest: vi.fn() }
  const turnStartedAt = 1_700_000_000_000

  const workingTab = {
    type: 'terminal',
    id: 'tab-1',
    terminal: 'term-1',
    launchAgent: 'claude',
    agentStatus: {
      state: 'working',
      workingMode: undefined as 'monitoring' | undefined,
      agentType: 'claude',
      lastAssistantMessage: 'Partial reply',
      providerSession: { id: 'session-1' },
      updatedAt: turnStartedAt,
      stateStartedAt: turnStartedAt,
      turnStartedAt
    },
    isActive: true
  }

  function Harness(): null {
    controller = useMobileNativeChatController({
      client: clientStub as unknown as RpcClient,
      connState: 'connected',
      hostId: 'h',
      worktreeId: 'w',
      activeSessionTab: workingTab as never,
      activeSessionTabId: 'tab-1',
      activeHandleRef: { current: 'term-1' },
      deviceTokenRef: { current: null },
      nativeChatTranscriptIsLocalReadable: true,
      nativeChatInputLeaseReady: true,
      onSendError: vi.fn(),
      onSendResolved: vi.fn()
    })
    return null
  }

  function rerender(): void {
    act(() => renderer?.update(createElement(Harness)))
  }

  beforeEach(() => {
    // Hook freshness is read against the clock, so pin it to the hook's own update.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(turnStartedAt)
    viewMode.isTabChatView = () => true
    workingTab.agentStatus.workingMode = undefined
    workingTab.agentStatus.stateStartedAt = turnStartedAt
    act(() => {
      renderer = create(createElement(Harness))
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    controller = null
    viewMode.isTabChatView = () => true
    Reflect.deleteProperty(sessionState, 'transcriptLifecycle')
    vi.useRealTimers()
  })

  it('runs the turn clock and streams the hook preview while the agent works', () => {
    expect(controller?.nativeChatTurnActive).toBe(true)
    expect(controller?.nativeChatCanStop).toBe(true)
    expect(controller?.nativeChatStreamingText).toBe('Partial reply')
    expect(controller?.nativeChatWorkingStartedAt).toBe(turnStartedAt)
  })

  it('treats passive monitoring as outside the foreground turn', () => {
    workingTab.agentStatus.workingMode = 'monitoring'
    rerender()

    expect(controller?.nativeChatTurnActive).toBe(false)
    expect(controller?.nativeChatStreamingText).toBeUndefined()
    expect(controller?.nativeChatSessionOptions?.isWorking).toBe(false)
  })

  it("ends working at the transcript's turn end when the final hook never came", () => {
    Object.assign(sessionState, {
      transcriptLifecycle: { state: 'completed', turnId: 't1', timestamp: turnStartedAt + 30_000 }
    })
    rerender()

    expect(controller?.nativeChatTurnActive).toBe(false)
    expect(controller?.nativeChatCanStop).toBe(false)
  })

  it('holds Stop until the agent starts a newer turn', () => {
    act(() => controller?.handleNativeChatStop())
    expect(controller?.nativeChatCanStop).toBe(false)

    workingTab.agentStatus.stateStartedAt = turnStartedAt + 60_000
    rerender()
    expect(controller?.nativeChatCanStop).toBe(true)
  })

  it('ends the Stop hold once a new message is sent, as desktop does', () => {
    act(() => controller?.handleNativeChatStop())
    expect(controller?.nativeChatCanStop).toBe(false)

    draftPending = [{ id: 'pending-1' }]
    try {
      rerender()
      expect(controller?.nativeChatCanStop).toBe(true)
    } finally {
      draftPending = []
    }
  })

  it('offers Stop again when the Escape definitely went nowhere', async () => {
    terminalStop.mockResolvedValueOnce(false)
    await act(async () => controller?.handleNativeChatStop())
    expect(controller?.nativeChatCanStop).toBe(true)
  })

  it('keeps the delayed-send route guard view-gated', () => {
    const before = answerSendArgs.at(-1)?.streamIdentity
    expect(before).toContain('term-1')

    viewMode.isTabChatView = () => false
    rerender()

    expect(answerSendArgs.at(-1)?.streamIdentity).not.toBe(before)
    expect(controller?.nativeChatTurnActive).toBe(false)
  })
})
