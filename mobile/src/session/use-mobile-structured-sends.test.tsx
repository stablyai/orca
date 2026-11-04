// Settle local echoes by the host’s submission id, never by matching text.

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../src/shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalDispatchState,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../src/shared/agent-session/journal/agent-session-journal-types'

import type { RpcClient } from '../transport/rpc-client'
import {
  acceptedSubmission,
  fieldsOf,
  ok,
  snapshotEvent
} from './use-mobile-structured-agent-session-queued.test-fixture'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

const asyncStorage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }))
vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

function recorded(
  clientMessageId: string,
  dispatchState: AgentJournalDispatchState = 'accepted',
  overrides: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    ...acceptedSubmission(clientMessageId),
    providerItemId: null,
    dispatchState,
    ...overrides
  }
}

function userRow(clientMessageId: string, text: string, sequence: number): AgentJournalRenderItem {
  return {
    itemId: agentJournalSubmissionKey(clientMessageId),
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
  }
}

function journal(items: AgentJournalRenderItem[], submissions: AgentJournalSubmission[]) {
  return snapshotEvent({ items, submissions })
}

describe('a structured send in the open chat', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: ReturnType<typeof useMobileStructuredAgentSession> | null = null
  let listener: ((value: unknown) => void) | null = null
  let answer: (id: string) => unknown = () => null
  const onSendError = vi.fn()
  const sendRequest = vi.fn<RpcClient['sendRequest']>(async () => ok({}))
  const client: RpcClient = {
    sendRequest,
    subscribe: vi.fn<RpcClient['subscribe']>((_method, _params, onData) => {
      if (_method === 'agentSession.subscribe') {
        listener = onData
      }
      return vi.fn()
    }),
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }

  function Harness(): null {
    hook = useMobileStructuredAgentSession({
      client,
      pairedHostClient: client,
      sessionId: 'session-1',
      sourceIdentity: 'host-a\0workspace-a',
      enabled: true,
      connected: true,
      agent: 'codex',
      hostSupport: null,
      onSendError
    })
    return null
  }

  async function mount(): Promise<void> {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() => listener?.(snapshotEvent()))
  }

  async function send(
    text: string,
    attachments?: { path: string; previewUri: string }[]
  ): Promise<string> {
    let id = ''
    sendRequest.mockImplementation(async (method, params) => {
      if (method !== 'agentSession.send') {
        return ok({ models: [], current: {} })
      }
      id = String(fieldsOf(fieldsOf(params).envelope).clientOperationId)
      return ok({
        ok: true,
        replayed: false,
        fence: 3,
        cursor: { epoch: 'epoch-1', sequence: 1 },
        value: answer(id)
      })
    })
    await act(async () => {
      await hook!.sendWithOutcome(
        text,
        attachments?.map((attachment) => attachment.previewUri),
        undefined,
        attachments
      )
    })
    return id
  }

  const shown = () =>
    hook!.session.messages.map((message) => [
      message.id,
      message.blocks.find((block) => block.type === 'text')?.text,
      ...(message.unsent ? ['unsent'] : [])
    ])

  beforeEach(() => {
    vi.clearAllMocks()
    answer = (id) => ({ clientMessageId: id, submission: recorded(id) })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    hook = null
    listener = null
  })

  it.each([false, true])(
    'forgets an acknowledged off-page echo after reconnect (snapshot beats reply: %s)',
    async (snapshotFirst) => {
      await mount()
      const snapshot = journal([userRow('newest', 'newest reply', 401)], [])
      if (snapshot.type !== 'snapshot') {
        throw new Error('Expected snapshot')
      }
      snapshot.page.liveCursor = { epoch: 'epoch-1', sequence: 401 }
      snapshot.page.window.nextCursor = snapshot.page.liveCursor
      snapshot.page.hasOlder = true
      if (snapshotFirst) {
        answer = (id) => {
          listener?.(snapshot)
          return { clientMessageId: id, submission: recorded(id) }
        }
      }
      const id = await send('sent before background streaming')
      if (!snapshotFirst) {
        expect(shown()).toEqual([
          [agentJournalSubmissionKey(id), 'sent before background streaming']
        ])
        act(() => listener?.(snapshot))
      }
      expect(shown()).toEqual([[agentJournalSubmissionKey('newest'), 'newest reply']])
      // Later pages must not revive echoes superseded by an authoritative read.
      act(() => listener?.(journal([], [])))
      expect(shown()).toEqual([])
      expect(onSendError).not.toHaveBeenCalled()
    }
  )

  // A recorded resend hides the earlier failed copy even when both have identical text.
  it('resends the words of a not-sent row as one bubble, with no stray copy', async () => {
    const failed = recorded('failed', 'rejected', { resolvedAt: 5, submittedAt: 4 })
    await mount()
    act(() => listener?.(journal([userRow('failed', 'hi', 1)], [failed])))
    expect(shown()).toEqual([[agentJournalSubmissionKey('failed'), 'hi', 'unsent']])

    const id = await send('hi')
    const resent = { ...recorded(id), submittedAt: 20 }
    act(() =>
      listener?.(journal([userRow('failed', 'hi', 1), userRow(id, 'hi', 2)], [failed, resent]))
    )
    expect(shown()).toEqual([[agentJournalSubmissionKey(id), 'hi']])
    expect(onSendError).not.toHaveBeenCalled()
  })
})
