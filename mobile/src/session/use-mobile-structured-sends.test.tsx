import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { createElement } from 'react'
import { act, type ReactTestRenderer } from 'react-test-renderer'
import { createWithQueryClient } from '../test-support/query-client-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../src/shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalDispatchState,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../src/shared/agent-session/journal/agent-session-journal-types'

import type { AgentSessionQueuedMessage } from '../../../src/shared/agent-session/requests/agent-session-queued-message-wire'
import type { RpcClient } from '../transport/rpc-client'
import {
  acceptedSubmission,
  fieldsOf,
  ok,
  snapshotEvent
} from './use-mobile-structured-agent-session-queued.test-fixture'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import { useMobileStructuredSends } from './use-mobile-structured-sends'
import { useMobileStructuredNativeChatSendBridge } from './use-mobile-structured-native-chat-send-bridge'
import { useMobileNativeChatDrafts } from './native-chat/composer/use-mobile-native-chat-drafts'
import {
  resetMobileNativeChatDraftStoreForTests,
  useMobileNativeChatDraft
} from './native-chat/composer/mobile-native-chat-draft-store'
// Settle local echoes by the host’s submission id, never by matching text.

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(async () => null),
  setItem: vi.fn(async () => {}),
  removeItem: vi.fn(async () => {})
}))
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
  let composer: {
    text: string
    edit: (text: string) => void
    send: ReturnType<typeof useMobileStructuredNativeChatSendBridge>['sendWithOutcome']
  } | null = null
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
    const drafts = useMobileNativeChatDrafts({
      hostId: 'host-a',
      worktreeId: 'workspace-a',
      tabId: 'tab-1',
      sessionId: 'session-1',
      messages: [],
      transcriptSettled: true
    })
    const bridge = useMobileStructuredNativeChatSendBridge({
      ...drafts,
      agent: 'codex',
      sendStructured: hook.sendWithOutcome,
      holdUnconfirmed: hook.holdUnconfirmed,
      onSendError
    })
    composer = {
      text: useMobileNativeChatDraft(drafts.draftKey),
      edit: drafts.setComposerText,
      send: bridge.sendWithOutcome
    }
    return null
  }

  async function mount(): Promise<void> {
    act(() => {
      renderer = createWithQueryClient(createElement(Harness))
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
    composer = null
    listener = null
    resetMobileNativeChatDraftStoreForTests()
    vi.useRealTimers()
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

  it('keeps the complete ordinary bubble for host-recorded uncertainty', async () => {
    await mount()
    answer = (id) => ({ clientMessageId: id, submission: recorded(id, 'unknown') })
    const id = await send('maybe')
    expect(shown()).toEqual([[agentJournalSubmissionKey(id), 'maybe']])
    expect(onSendError).not.toHaveBeenCalled()
  })

  it('shows unknown transport input with its photo and joins only its exact row', async () => {
    await mount()
    sendRequest.mockImplementation(async (method) => {
      if (method === 'agentSession.send') {
        throw markRpcDeliveryUnknown(new Error('connection lost'))
      }
      return ok({ models: [], current: {} })
    })
    await act(async () => {
      expect(
        await hook!.sendWithOutcome('Full original prose', ['file:///original.png'], undefined, [
          { path: '/host/original.png', previewUri: 'file:///original.png' }
        ])
      ).toBe('unknown')
    })
    const row = hook!.session.messages[0]!
    expect(row.blocks).toEqual([
      { type: 'text', text: 'Full original prose' },
      { type: 'image-ref', path: '/host/original.png' }
    ])
    expect(hook!.imagePreviewsByMessageId[row.id]).toEqual(['file:///original.png'])
    act(() => listener?.(journal([userRow('unrelated', 'different input', 1)], [])))
    expect(hook!.session.messages.some((message) => message.id === row.id)).toBe(true)
    const id = String(
      fieldsOf(
        fieldsOf(sendRequest.mock.calls.find(([method]) => method === 'agentSession.send')?.[1])
          .envelope
      ).clientOperationId
    )
    act(() => listener?.(journal([userRow(id, 'Full original prose', 2)], [recorded(id)])))
    expect(shown()).toEqual([[row.id, 'Full original prose']])
    expect(onSendError).not.toHaveBeenCalled()
  })

  it('hands back only the lost-reply sends the journal never recorded', async () => {
    await mount()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const ids: string[] = []
    sendRequest.mockImplementation(async (method, params) => {
      if (method !== 'agentSession.send') {
        return ok({ models: [], current: {} })
      }
      ids.push(String(fieldsOf(fieldsOf(params).envelope).clientOperationId))
      throw markRpcDeliveryUnknown(new Error('connection lost'))
    })
    for (const text of ['landed text', 'lost text']) {
      act(() => composer!.edit(text))
      await act(async () => {
        expect(await composer!.send(text)).toBe('unknown')
      })
    }
    expect(composer!.text).toBe('')
    act(() => listener?.(journal([userRow(ids[0]!, 'landed text', 1)], [recorded(ids[0]!)])))
    act(() => composer!.edit('typed meanwhile'))
    act(() => {
      vi.advanceTimersByTime(20_000)
    })
    expect(composer!.text).toBe('typed meanwhile\n\nlost text')
    expect(shown()).toEqual([[agentJournalSubmissionKey(ids[0]!), 'landed text']])
    expect(onSendError).toHaveBeenCalledTimes(1)
    expect(onSendError).toHaveBeenCalledWith('Not confirmed. Restored to the box.')
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
        renderer = createWithQueryClient(createElement(Harness, props))
      }
    })
  }

  const message = (clientMessageId: string) => ({
    clientMessageId,
    body: { kind: 'message' as const, role: 'user' as const, blocks: [] },
    queuedAt: 1
  })

  const handedBack = vi.fn()

  function hold(clientMessageId: string): void {
    act(() => {
      sends!.accept(message(clientMessageId))
      sends!.holdUnconfirmed(clientMessageId, () => handedBack(clientMessageId))
    })
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

  it('bounds real accept/reconciliation work linearly at N and 10N retained inputs', () => {
    const work = [20, 200].map((count) => {
      render({ sessionKey: `population-${count}` })
      let reads = 0
      act(() => {
        for (let index = 0; index < count; index++) {
          const entry = message(`retained-${index}`)
          sends!.accept({
            ...entry,
            get clientMessageId() {
              reads++
              return entry.clientMessageId
            }
          })
        }
      })
      reads = 0
      act(() => sends!.accept(message(`retained-${count - 1}`)))
      const operations = reads
      expect(sends!.optimistic).toHaveLength(count)
      expect(operations).toBeGreaterThanOrEqual(count)
      expect(operations).toBeLessThanOrEqual(4 * count)
      return operations
    })
    console.info('DL1 retained-input ID reads N/10N:', work)
  })

  it('hands back an unrecorded lost send at the deadline, independently of newer sends', () => {
    render({ sessionKey: 'a' })
    hold('lost')
    expect(drawn()).toEqual(['lost'])
    act(() => sends!.accept(message('next')))
    render({ sessionKey: 'a', submissions: [recorded('other')] })
    expect(drawn()).toEqual(['lost', 'next'])
    act(() => {
      vi.advanceTimersByTime(20_000)
    })
    expect(drawn()).toEqual(['next'])
    expect(handedBack.mock.calls).toEqual([['lost']])
  })

  it('keeps a lost send the journal recorded while another chat was open', () => {
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
    expect(handedBack).not.toHaveBeenCalled()
  })

  it('releases its view-owned memory when the chat screen goes away', () => {
    render({ sessionKey: 'a' })
    hold('lost')
    act(() => renderer?.unmount())
    renderer = null
    expect(vi.getTimerCount()).toBe(0)
    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(handedBack).not.toHaveBeenCalled()
  })
})
