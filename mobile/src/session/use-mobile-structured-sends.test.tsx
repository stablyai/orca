// Settle local echoes by the host’s submission id, never by matching text.

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../src/shared/agent-session-journal-item-key'
import type {
  AgentJournalDispatchState,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../src/shared/agent-session-journal-types'
import type { AgentSessionQueuedMessage } from '../../../src/shared/agent-session-wire'
import { DISPATCH_REJECTED_CANCELLED } from '../../../src/shared/structured-agent-session-dispatch-rejection'
import type { RpcClient } from '../transport/rpc-client'
import {
  acceptedSubmission,
  fieldsOf,
  ok,
  queuedDraft,
  snapshotEvent
} from './use-mobile-structured-agent-session-queued.test-fixture'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import { useMobileStructuredSends } from './use-mobile-structured-sends'

const asyncStorage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }))
vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

const UNCONFIRMED = 'Delivery unconfirmed — check chat before retrying'

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
      listener = onData
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

  it('draws one bubble under its own id until its row lands, then only the row', async () => {
    await mount()
    const id = await send('hello')
    const row = agentJournalSubmissionKey(id)
    expect(shown()).toEqual([[row, 'hello']])

    act(() => listener?.(journal([], [])))
    expect(shown()).toEqual([[row, 'hello']])

    act(() => listener?.(journal([userRow(id, 'hello', 1)], [recorded(id)])))
    expect(shown()).toEqual([[row, 'hello']])
    expect(hook!.session.messages[0]?.timestamp).toBe(1)
    expect(onSendError).not.toHaveBeenCalled()
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

  it('draws nothing for a send whose answer was lost', async () => {
    await mount()
    answer = (id) => ({ clientMessageId: id, submission: recorded(id, 'unknown') })
    await send('maybe')
    expect(shown()).toEqual([])
  })

  it('draws nothing of its own for a send the host keeps as a card', async () => {
    await mount()
    answer = (id) => ({
      clientMessageId: id,
      queued: { messageId: id, state: 'waiting', position: 1 }
    })
    await send('later')
    expect(shown()).toEqual([])
  })

  it('leaves a send a Stop took back to its row and stop row', async () => {
    await mount()
    const withdrawn = (id: string) =>
      recorded(id, 'rejected', { reason: DISPATCH_REJECTED_CANCELLED, resolvedAt: 11 })
    answer = (id) => ({ clientMessageId: id, submission: withdrawn(id) })
    const id = await send('stop me')
    act(() => listener?.(journal([userRow(id, 'stop me', 1)], [withdrawn(id)])))
    expect(hook!.session.messages.map((message) => message.id)).toEqual([
      agentJournalSubmissionKey(id),
      `stopped-before-start:${agentJournalSubmissionKey(id)}`
    ])
  })

  it("shows this phone's photo on the bubble, the landed row and a not-sent row", async () => {
    await mount()
    const id = await send('look', [{ path: '/host/a.jpg', previewUri: 'file:///a.jpg' }])
    const row = agentJournalSubmissionKey(id)
    expect(hook!.imagePreviewsByMessageId).toEqual({ [row]: ['file:///a.jpg'] })
    expect(hook!.session.messages[0]?.blocks).toContainEqual({
      type: 'image-ref',
      path: '/host/a.jpg'
    })

    act(() => listener?.(journal([userRow(id, 'look', 1)], [recorded(id, 'rejected')])))
    expect(shown()).toEqual([[row, 'look', 'unsent']])
    expect(hook!.imagePreviewsByMessageId).toEqual({ [row]: ['file:///a.jpg'] })
  })
})

describe('a structured send whose answer was lost', () => {
  let renderer: ReactTestRenderer | null = null
  let sends: ReturnType<typeof useMobileStructuredSends> | null = null
  const onSendError = vi.fn()

  function Harness(props: {
    sessionKey: string
    submissions?: AgentJournalSubmission[]
    queuedMessages?: AgentSessionQueuedMessage[]
  }): null {
    sends = useMobileStructuredSends({
      sessionKey: props.sessionKey,
      submissions: props.submissions ?? [],
      queuedMessages: props.queuedMessages ?? null,
      onSendError
    })
    return null
  }

  function render(props: Parameters<typeof Harness>[0]): void {
    act(() => {
      if (renderer) {
        renderer.update(createElement(Harness, props))
      } else {
        renderer = create(createElement(Harness, props))
      }
    })
  }

  const message = (clientMessageId: string) => ({
    clientMessageId,
    body: { kind: 'message' as const, role: 'user' as const, blocks: [] },
    queuedAt: 1
  })

  function hold(clientMessageId: string): void {
    act(() => sends!.hold(message(clientMessageId)))
  }

  const drawn = () => sends!.optimistic.map((send) => send.clientMessageId)

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    sends = null
    vi.useRealTimers()
  })

  it('is never drawn, and says so once if the host never shows it', () => {
    render({ sessionKey: 'a' })
    hold('lost')
    expect(drawn()).toEqual([])
    act(() => sends!.accept(message('next')))
    render({ sessionKey: 'a', submissions: [recorded('other')] })
    expect(drawn()).toEqual(['next'])
    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(drawn()).toEqual(['next'])
    expect(onSendError).toHaveBeenCalledTimes(1)
    expect(onSendError).toHaveBeenCalledWith(UNCONFIRMED)
  })

  it.each([
    ['recorded', { submissions: [recorded('lost')] }],
    ['held as a card', { queuedMessages: [queuedDraft({ messageId: 'lost' })] }],
    ['handed off from its card', { submissions: [acceptedSubmission('next', 'lost')] }]
  ])('stays quiet once the host shows it %s', (_case, shownBy) => {
    render({ sessionKey: 'a' })
    hold('lost')
    render({ sessionKey: 'a', ...shownBy })
    expect(vi.getTimerCount()).toBe(0)
    expect(drawn()).toEqual([])
    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(onSendError).not.toHaveBeenCalled()
  })

  it('stays quiet when the record beat the answer', () => {
    render({ sessionKey: 'a', submissions: [recorded('lost')] })
    hold('lost')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps its hold while another chat is open, and settles it back in its own', () => {
    render({ sessionKey: 'a' })
    hold('lost')
    render({ sessionKey: 'b', submissions: [recorded('other')] })
    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    render({ sessionKey: 'a', submissions: [recorded('lost')] })
    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(onSendError).not.toHaveBeenCalled()
  })

  it('stops its deadline when the chat screen goes away', () => {
    render({ sessionKey: 'a' })
    hold('lost')
    act(() => renderer?.unmount())
    renderer = null
    expect(vi.getTimerCount()).toBe(0)
    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(onSendError).not.toHaveBeenCalled()
  })

  it('ignores an answer lost after the chat screen went away', () => {
    render({ sessionKey: 'a' })
    act(() => renderer?.unmount())
    renderer = null
    hold('lost')
    expect(vi.getTimerCount()).toBe(0)
  })
})
