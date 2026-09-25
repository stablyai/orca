import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import type { StructuredAgentSessionState } from '../../../src/shared/structured-agent-session-reducer'
import type { RpcClient } from '../transport/rpc-client'

const mocks = vi.hoisted(() => ({ sendRequest: vi.fn() }))
vi.mock('./use-mobile-structured-agent-state', () => ({
  useMobileStructuredAgentState: () => ({
    state,
    stateRef,
    loadingOlder: false,
    loadEarlier: vi.fn()
  })
}))
vi.mock('./use-mobile-structured-agent-options', () => ({
  useMobileStructuredAgentOptions: () => ({
    conversationCommands: [],
    invokeStructuredOption: vi.fn(),
    optionSnapshot: [],
    optionSurface: { getSnapshot: () => [], subscribe: () => () => {} },
    pendingOptionId: null,
    setStructuredOption: vi.fn()
  })
}))
vi.mock('./use-mobile-structured-prompt-responses', () => ({
  useMobileStructuredPromptResponses: () => ({
    groupedDraft: null,
    respondPermission: vi.fn(),
    respondQuestion: vi.fn()
  })
}))
vi.mock('./use-mobile-structured-send-operation-reconciliation', () => ({
  useMobileStructuredSendOperationReconciliation: vi.fn()
}))

import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

const pendingApproval = (): AgentJournalRenderItem => ({
  itemId: 'approval-1',
  revision: 4,
  sequence: 2,
  observedAt: 2,
  body: {
    kind: 'approval',
    title: 'Allow Bash?',
    detail: null,
    options: [{ id: 'allow', label: 'Allow' }],
    resolution: {
      state: 'pending',
      selectedOptionId: null,
      resolvedBy: null,
      resolvedAt: null
    }
  }
})

const runningTurn = (): AgentJournalRenderItem => ({
  itemId: 'turn-status',
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: {
    kind: 'status',
    text: 'Waiting',
    turnLifecycle: { turnId: 'turn-1', state: 'running' }
  }
})

const pendingQuestion = (): AgentJournalRenderItem => ({
  itemId: 'question-1',
  revision: 7,
  sequence: 2,
  observedAt: 2,
  body: {
    kind: 'question',
    question: 'Pick a destination',
    options: [{ id: 'local', label: 'Local' }],
    resolution: {
      state: 'pending',
      selectedOptionId: null,
      resolvedBy: null,
      resolvedAt: null
    }
  }
})

let state: StructuredAgentSessionState
const stateRef = {
  get current(): StructuredAgentSessionState {
    return state
  }
}
const client: RpcClient = {
  sendRequest: mocks.sendRequest,
  subscribe: () => () => {},
  updateTerminalSubscriptionViewport: () => {},
  getState: () => 'connected',
  getReconnectAttempt: () => 0,
  getLastConnectedAt: () => null,
  onStateChange: () => () => {},
  notifyForeground: () => {},
  close: () => {}
}

function Harness({ promptCancelSupported }: { promptCancelSupported: boolean }): null {
  hook = useMobileStructuredAgentSession({
    client,
    sessionId: 'session-1',
    sourceIdentity: 'host-a\0workspace-a',
    enabled: true,
    connected: true,
    agent: 'codex',
    promptCancelSupported,
    onSendError: vi.fn()
  })
  return null
}

let hook: ReturnType<typeof useMobileStructuredAgentSession>
let renderer: ReactTestRenderer | null = null

describe('mobile structured prompt cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state = {
      epoch: 'epoch-1',
      cursor: { epoch: 'epoch-1', sequence: 2 },
      fence: 3,
      items: [runningTurn(), pendingApproval()],
      submissions: [],
      retainedItemLimit: 1024,
      hasOlder: false,
      status: 'ready'
    }
    mocks.sendRequest.mockResolvedValue({
      ok: true,
      result: {
        ok: true,
        replayed: false,
        fence: 3,
        cursor: { epoch: 'epoch-1', sequence: 3 },
        value: { turnId: 'turn-1', cancelled: true }
      }
    })
    renderer = null
  })
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('sends the clicked prompt identity on capable hosts', async () => {
    act(() => {
      renderer = create(createElement(Harness, { promptCancelSupported: true }))
    })
    await act(async () => {
      expect(await hook.cancelPrompt()).toBe(true)
    })
    expect(mocks.sendRequest).toHaveBeenCalledWith(
      'agentSession.cancel',
      expect.objectContaining({
        turnId: 'turn-1',
        prompt: { itemId: 'approval-1', expectedRevision: 4 }
      }),
      expect.any(Object)
    )
  })

  it('downgrades to turn-only cancellation on an old host', async () => {
    act(() => {
      renderer = create(createElement(Harness, { promptCancelSupported: false }))
    })
    await act(async () => {
      expect(await hook.cancelPrompt()).toBe(true)
    })
    const call = mocks.sendRequest.mock.calls.find(([method]) => method === 'agentSession.cancel')
    expect(call?.[1]).toMatchObject({ turnId: 'turn-1' })
    expect(call?.[1]).not.toHaveProperty('prompt')
  })

  it('cancels a question card with its item identity', async () => {
    state = { ...state, items: [runningTurn(), pendingQuestion()] }
    act(() => {
      renderer = create(createElement(Harness, { promptCancelSupported: true }))
    })
    await act(async () => {
      expect(await hook.cancelPrompt({ itemId: 'question-1', expectedRevision: 7 })).toBe(true)
    })
    expect(mocks.sendRequest).toHaveBeenCalledWith(
      'agentSession.cancel',
      expect.objectContaining({
        turnId: 'turn-1',
        prompt: { itemId: 'question-1', expectedRevision: 7 }
      }),
      expect.any(Object)
    )
  })

  it('uses the rendered prompt identity when the journal changes before tap', async () => {
    act(() => {
      renderer = create(createElement(Harness, { promptCancelSupported: true }))
    })
    const renderedIdentity = { itemId: 'approval-1', expectedRevision: 4 }
    state = {
      ...state,
      items: [runningTurn(), { ...pendingApproval(), itemId: 'approval-new', revision: 9 }]
    }
    // The hook API accepts the identity captured by the card; the state is intentionally newer.
    await act(async () => {
      expect(await hook.cancelPrompt(renderedIdentity)).toBe(true)
    })
    expect(mocks.sendRequest).toHaveBeenCalledWith(
      'agentSession.cancel',
      expect.objectContaining({ prompt: renderedIdentity }),
      expect.any(Object)
    )
  })
})
