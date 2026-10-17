import { describe, expect, it, vi } from 'vitest'
import {
  OrchestrationStructuredMailboxPointerDelivery,
  type StructuredMailboxPointerHost
} from './structured-mailbox-pointer-delivery'
import type { StructuredMailSubmission } from './structured-pointer-operation-id'
import { AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS } from '../../../shared/agent-session-host-authority'
import type { StructuredWorkerIdentity } from '../structured-worker-identity'
import { RuntimeMessageWaiters } from '../runtime-message-waiters'

const IDENTITY: StructuredWorkerIdentity = {
  handle: 'structworker_1',
  sessionId: 'session-1',
  agent: 'claude',
  paneKey: 'structured-agent-session-session-1:11111111-1111-4111-a111-111111111111',
  processIncarnation: 'structured:session-1',
  worktreeId: 'wt_1',
  hostScope: { kind: 'local', hostId: 'local' }
}

function harness(options: {
  /** False: the session cannot be read (not attached). */
  attached?: boolean
  dispatchState?: 'accepted' | 'rejected' | 'unknown'
  /** The chat was busy: its queue holds the message as a card. */
  queued?: true
  /** The mailbox this worker owns; its own handle for direct peer mail outside a dispatch. */
  mailbox?: string
  dispatchId?: string | null
  waiters?: RuntimeMessageWaiters
  /** The consumer holds an unacknowledged `check` batch for this mailbox. */
  outstanding?: boolean
}) {
  const mailbox = options.mailbox ?? 'dispatch:d1'
  const dispatchId = options.dispatchId === undefined ? 'd1' : options.dispatchId
  let attached = options.attached ?? true
  let promptWaiting = false
  // The session's recorded sends, as its journal reports them.
  let submissions: StructuredMailSubmission[] = []
  // The mailbox's unread mail; a message the chat received is no longer selected.
  const mail = [mailRow('m1', 3, mailbox)]
  const received = new Set<string>()
  const markAsRead = vi.fn((ids: string[]) => {
    for (const id of ids) {
      received.add(id)
    }
  })
  const send: StructuredMailboxPointerHost['send'] = vi.fn(async () =>
    promptWaiting
      ? { kind: 'held' as const }
      : options.queued
        ? { kind: 'queued' as const }
        : { kind: 'sent' as const, state: options.dispatchState ?? ('accepted' as const) }
  )
  const sendMock = vi.mocked(send)
  const readContext = vi.fn<StructuredMailboxPointerHost['currentContextClearOperationId']>(
    () => undefined
  )
  const db = {
    getDispatchContextById: () => ({ run_id: 'run_1' }),
    hasOutstandingMailboxDelivery: () => options.outstanding ?? false,
    getUndeliveredUnreadMessages: (
      _handle: string,
      _filter: unknown,
      input: { excludeTypes: readonly string[] }
    ) =>
      mail.filter(
        (message) => !received.has(message.id) && !input.excludeTypes.includes(message.type)
      ),
    getInbox: () => mail.slice(-1),
    getMessageById: (id: string) => {
      const row = mail.find((message) => message.id === id)
      return row && { ...row, read: received.has(id) ? 1 : 0 }
    },
    markAsReadAndDelivered: markAsRead,
    markAsRead,
    markAsDelivered: vi.fn()
  }
  const delivery = new OrchestrationStructuredMailboxPointerDelivery({
    getDb: () => db as never,
    getMessageWaiters: (handle) => options.waiters?.get(handle),
    resolveStructuredTarget: (mailboxHandle) =>
      mailboxHandle === mailbox ? { sessionId: IDENTITY.sessionId, dispatchId } : null,
    getCliCommand: () => 'orca-dev',
    senderName: (party) => (party.address === 'term_coord' ? 'Coordinator' : null),
    host: {
      readSessionFacts: async () => (attached ? { submissions } : null),
      currentFence: () => 4,
      currentContextClearOperationId: readContext,
      hasActionablePromptNow: () => promptWaiting,
      send
    }
  })
  return {
    delivery,
    markAsRead,
    send: sendMock,
    readContext,
    setAttached: (next: boolean) => {
      attached = next
    },
    receive: (id: string, sequence: number, type = 'status') => {
      mail.push({ ...mailRow(id, sequence, mailbox), type })
    },
    setSubmissions: (next: StructuredMailSubmission[]) => {
      submissions = next
    },
    setPromptWaiting: (next: boolean) => {
      promptWaiting = next
    }
  }
}

function mailRow(id: string, sequence: number, mailbox: string) {
  return {
    id,
    type: 'status',
    sequence,
    from_handle: 'term_coord',
    to_handle: mailbox,
    run_id: 'run_1',
    subject: `subject ${id}`,
    body: `body ${id}`,
    priority: 'normal',
    payload: null
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('structured mail delivery', () => {
  it.each(['rejected', 'unknown', 'throws'] as const)(
    'attempts an unchanged record context once when its journal has no marker and send is %s',
    async (outcome) => {
      const { delivery, send, readContext, markAsRead } = harness({})
      let contextReads = 0
      readContext.mockImplementation(() => {
        if (++contextReads > 8) {
          throw new Error('hard regression-test cap on context reads')
        }
        return 'record-clear-1'
      })
      send.mockImplementation(async () => {
        if (outcome === 'throws') {
          throw new Error('send failed')
        }
        return { kind: 'sent', state: outcome }
      })
      delivery.deliverForHandle('dispatch:d1')
      await flush()
      await flush()
      expect(send).toHaveBeenCalledTimes(1)
      expect(contextReads).toBeLessThan(8)
      expect(markAsRead).not.toHaveBeenCalled()
    }
  )

  it('sends a second report after its filtered waiter expires during first-report acceptance', async () => {
    const waiters = new RuntimeMessageWaiters()
    const { delivery, send, receive, markAsRead } = harness({
      mailbox: 'run:run_1',
      waiters
    })
    const waiting = waiters.wait('run:run_1', { typeFilter: ['worker_done'], timeoutMs: 40 })
    const accepted = Promise.withResolvers<void>()
    send.mockImplementationOnce(async () => {
      await accepted.promise
      return { kind: 'sent', state: 'accepted' }
    })
    delivery.deliverForHandle('run:run_1', new Set(['worker_done']))
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(await waiting).toBe('timed_out')
    receive('m2', 4, 'worker_done')
    delivery.deliverForHandle('run:run_1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    accepted.resolve()
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(send.mock.calls[1]![0].body.from).toMatchObject({
      orchestration: { messages: [{ messageId: 'm2' }] }
    })
    expect(markAsRead.mock.calls).toEqual([[['m1']], [['m2']]])
    delivery.onJournalActivity('session-1')
    delivery.deliverForHandle('run:run_1')
    await flush()
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('claims only mailboxes whose assignee is a structured worker', () => {
    const { delivery } = harness({})
    expect(delivery.deliverForHandle('dispatch:d1')).toBe(true)
    expect(delivery.deliverForHandle('run:run_1')).toBe(false)
  })

  it('sends the message as a turn and consumes it on an accepted dispatch', async () => {
    const { delivery, markAsRead, send } = harness({})
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0].operationId).toMatch(/^\d{13}-[0-9a-f]{32}$/)
    expect(markAsRead).toHaveBeenCalledWith(['m1'])
  })

  it('sends through the worker`s own handle for direct peer mail outside a dispatch', async () => {
    const { delivery, send, markAsRead } = harness({
      mailbox: IDENTITY.handle,
      dispatchId: null
    })
    expect(delivery.deliverForHandle(IDENTITY.handle)).toBe(true)
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0].dispatchId).toBeNull()
    expect(markAsRead).toHaveBeenCalledWith(['m1'])
  })

  it('releases its in-flight lane when reading the context fails', async () => {
    const { delivery, send, readContext, markAsRead } = harness({})
    readContext.mockImplementationOnce(() => {
      throw new Error('record unavailable')
    })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).not.toHaveBeenCalled()
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).toHaveBeenCalledOnce()
    expect(markAsRead).toHaveBeenCalledWith(['m1'])
  })

  it('retains mail when the dispatch settles unknown', async () => {
    const { delivery, markAsRead } = harness({
      dispatchState: 'unknown'
    })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(markAsRead).not.toHaveBeenCalled()
  })

  it('retains mail when the session is not attached', async () => {
    const { delivery, send } = harness({ attached: false })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).not.toHaveBeenCalled()
  })

  it('holds mail while a prompt waits on the person, keeps later mail behind it, then sends both in order', async () => {
    const { delivery, send, markAsRead, receive, setPromptWaiting } = harness({})
    receive('m2', 4)
    setPromptWaiting(true)
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(markAsRead).not.toHaveBeenCalled()
    setPromptWaiting(false)
    delivery.onJournalActivity('session-1')
    await vi.waitFor(() => expect(markAsRead.mock.calls).toEqual([[['m1']], [['m2']]]))
    const sentIds = send.mock.calls.map(([input]) => input.body.from?.orchestration)
    expect(sentIds.at(-2)).toMatchObject({ messages: [{ messageId: 'm1' }] })
    expect(sentIds.at(-1)).toMatchObject({ messages: [{ messageId: 'm2' }] })
  })

  it('leaves a mailbox to its unacknowledged check batch', async () => {
    const { delivery, send } = harness({ outstanding: true })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).not.toHaveBeenCalled()
  })

  it('redrives a detached session when the journal replays on re-attach', async () => {
    // A transient detach parks nothing to be woken unless `session-not-attached` waits for the
    // journal edge, and the dispatch preamble tells the worker not to poll.
    const { delivery, send, setAttached, markAsRead } = harness({ attached: false })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).not.toHaveBeenCalled()
    setAttached(true)
    delivery.onJournalActivity('session-1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(markAsRead).toHaveBeenCalledWith(['m1'])
  })

  it('sends each message whole through the chat, with who it is from, and counts it received once queued', async () => {
    const { delivery, send, markAsRead, receive } = harness({ queued: true })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    const text = send.mock.calls[0]![0].body.blocks[0]
    expect(text).toMatchObject({ text: expect.stringContaining('body m1') })
    expect(text).toMatchObject({
      text: expect.stringContaining('`orca-dev orchestration reply --id m1 --body "..."`')
    })
    expect(send.mock.calls[0]![0].body.from).toEqual({
      kind: 'agent',
      senders: [
        {
          party: { address: 'term_coord', terminalHandle: 'term_coord', orcaSessionId: null },
          name: 'Coordinator'
        }
      ],
      orchestration: {
        message: 'mail-notice',
        mailbox: 'dispatch:d1',
        dispatchId: 'd1',
        messages: [{ messageId: 'm1', runId: 'run_1', from: 'term_coord' }],
        carriesMailContent: true
      }
    })
    // The chat's queue holds it now, as it holds the person's: it is not sent again.
    expect(markAsRead).toHaveBeenCalledWith(['m1'])
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    // A heartbeat is never sent, and stays unread for `check`.
    receive('beat', 4, 'heartbeat')
    receive('m2', 5)
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(markAsRead).not.toHaveBeenCalledWith(['beat'])
    expect(send.mock.calls.map(([input]) => input.body.from?.orchestration)).toEqual([
      expect.objectContaining({
        messages: [{ messageId: 'm1', runId: 'run_1', from: 'term_coord' }]
      }),
      expect.objectContaining({
        messages: [{ messageId: 'm2', runId: 'run_1', from: 'term_coord' }]
      })
    ])
  })

  it('retries a rejected send on the next journal edge, under the same id', async () => {
    // A rejection consumes no mail and nothing else redrives this mailbox, so leaving it unparked
    // stranded the worker until unrelated mail happened to arrive. The retry keeps the id: the host
    // replays a recorded refusal rather than starting the agent again.
    const { delivery, send, markAsRead } = harness({
      dispatchState: 'rejected'
    })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(markAsRead).not.toHaveBeenCalled()
    const first = send.mock.calls[0]![0].operationId
    delivery.onJournalActivity('session-1')
    await flush()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]![0].operationId).toBe(first)
  })

  it('points again under a new id once a later send ran', async () => {
    const { delivery, send, setSubmissions } = harness({
      dispatchState: 'unknown'
    })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    const first = send.mock.calls[0]![0].operationId
    setSubmissions([
      { clientMessageId: first, dispatchState: 'unknown', submittedAt: Date.now() },
      { clientMessageId: 'user-turn', dispatchState: 'accepted', submittedAt: Date.now() + 1 }
    ])
    delivery.onJournalActivity('session-1')
    await flush()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]![0].operationId).not.toBe(first)
  })

  it('sends once more under a new id for a send an earlier process left in doubt', async () => {
    const { delivery, send, setSubmissions } = harness({
      dispatchState: 'unknown'
    })
    const earlier = {
      clientMessageId: 'earlier-process-op',
      dispatchState: 'unknown' as const,
      submittedAt: Date.now(),
      mailMessageId: 'm1'
    }
    setSubmissions([earlier])
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    const reminted = send.mock.calls[0]![0].operationId
    expect(reminted).not.toBe('earlier-process-op')
    // Minted by this process, the new id replays from here on.
    setSubmissions([
      earlier,
      {
        clientMessageId: reminted,
        dispatchState: 'unknown',
        submittedAt: Date.now(),
        mailMessageId: 'm1'
      }
    ])
    delivery.onJournalActivity('session-1')
    await flush()
    expect(send.mock.calls[1]![0].operationId).toBe(reminted)
  })

  it('keeps replaying its own send across a clock step, and re-mints only for a rewind that ran a turn', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { delivery, send, setSubmissions } = harness({
        dispatchState: 'unknown'
      })
      // The wall clock steps back an hour after the lane started: its own row is still its own.
      vi.setSystemTime(Date.now() - 60 * 60 * 1000)
      delivery.deliverForHandle('dispatch:d1')
      await flush()
      const first = send.mock.calls[0]![0].operationId
      setSubmissions([
        { clientMessageId: first, dispatchState: 'unknown', submittedAt: Date.now() }
      ])
      delivery.onJournalActivity('session-1')
      await flush()
      expect(send.mock.calls[1]![0].operationId).toBe(first)
      // A rewind dropped that send from the journal, and the person's turn ran after it.
      setSubmissions([
        { clientMessageId: 'user-turn', dispatchState: 'accepted', submittedAt: Date.now() + 1 }
      ])
      delivery.onJournalActivity('session-1')
      await flush()
      expect(send.mock.calls[2]![0].operationId).not.toBe(first)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not read a turn from before a backward clock step as one that ran after its send', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { delivery, send, setSubmissions } = harness({
        dispatchState: 'unknown'
      })
      const personTurn = {
        clientMessageId: 'user-turn',
        dispatchState: 'accepted' as const,
        submittedAt: Date.now()
      }
      setSubmissions([personTurn])
      vi.setSystemTime(Date.now() - 2 * 60 * 1000)
      delivery.deliverForHandle('dispatch:d1')
      await flush()
      const first = send.mock.calls[0]![0].operationId
      setSubmissions([
        personTurn,
        { clientMessageId: first, dispatchState: 'unknown', submittedAt: Date.now() }
      ])
      for (let edge = 0; edge < 3; edge++) {
        delivery.onJournalActivity('session-1')
        await flush()
      }
      expect(send.mock.calls.map(([input]) => input.operationId)).toEqual([
        first,
        first,
        first,
        first
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('never re-mints an ambiguous send after the host replay window expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { delivery, send, setSubmissions } = harness({ dispatchState: 'unknown' })
      delivery.deliverForHandle('dispatch:d1')
      await flush()
      const first = send.mock.calls[0]![0].operationId
      setSubmissions([
        { clientMessageId: first, dispatchState: 'unknown', submittedAt: Date.now() }
      ])
      // Its recorded verdict is the only evidence of whether it landed; age changes nothing.
      vi.setSystemTime(Date.now() + AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS + 60_000)
      delivery.onJournalActivity('session-1')
      await flush()
      expect(send.mock.calls[1]![0].operationId).toBe(first)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stamps a message whose echo arrived after the lane stopped waiting, sending nothing more', async () => {
    const { delivery, send, markAsRead, setSubmissions } = harness({
      dispatchState: 'unknown'
    })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    const first = send.mock.calls[0]![0].operationId
    setSubmissions([{ clientMessageId: first, dispatchState: 'pending', submittedAt: Date.now() }])
    delivery.onJournalActivity('session-1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    setSubmissions([{ clientMessageId: first, dispatchState: 'accepted', submittedAt: Date.now() }])
    delivery.onJournalActivity('session-1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(markAsRead).toHaveBeenCalledWith(['m1'])
  })
})

describe('forgetting one settled worker', () => {
  /** Two workers, each detached and so each parked on its OWN session's journal edge. */
  function twoWorkerHarness() {
    let resolves = true
    let attached = false
    const sessionByMailbox: Record<string, string> = {
      'dispatch:d1': 'session-1',
      'dispatch:d2': 'session-2'
    }
    const send: StructuredMailboxPointerHost['send'] = vi.fn(async () => ({
      kind: 'sent' as const,
      state: 'accepted' as const
    }))
    const db = {
      getDispatchContextById: () => ({ run_id: 'run_1' }),
      getUndeliveredUnreadMessages: () => [mailRow('m1', 3, 'dispatch:d1')],
      getInbox: () => [mailRow('m1', 3, 'dispatch:d1')],
      getMessageById: () => ({ ...mailRow('m1', 3, 'dispatch:d1'), read: 0 }),
      markAsReadAndDelivered: vi.fn(),
      markAsRead: vi.fn(),
      markAsDelivered: vi.fn()
    }
    const delivery = new OrchestrationStructuredMailboxPointerDelivery({
      getDb: () => db as never,
      getMessageWaiters: () => undefined,
      resolveStructuredTarget: (mailboxHandle) => {
        const sessionId = sessionByMailbox[mailboxHandle]
        return resolves && sessionId
          ? { sessionId, dispatchId: mailboxHandle.slice('dispatch:'.length) }
          : null
      },
      getCliCommand: () => 'orca',
      senderName: () => null,
      host: {
        readSessionFacts: async () => (attached ? { submissions: [] } : null),
        currentFence: () => 4,
        currentContextClearOperationId: () => undefined,
        hasActionablePromptNow: () => false,
        send
      }
    })
    return {
      delivery,
      send: vi.mocked(send),
      attach: () => {
        attached = true
      },
      stopResolving: () => {
        resolves = false
      },
      resumeResolving: () => {
        resolves = true
      }
    }
  }

  it("keeps a sibling worker's wake-up edge when the target cannot be resolved", async () => {
    // The bug: `forgetSession` re-resolved every parked mailbox and pruned the ones that answered
    // null. A momentarily null DB reference or a session mid-teardown made that EVERY worker, so
    // the sibling's mail stayed durable but lost the edge that would have woken it.
    const { delivery, send, attach, stopResolving, resumeResolving } = twoWorkerHarness()
    delivery.deliverForHandle('dispatch:d1')
    delivery.deliverForHandle('dispatch:d2')
    await flush()
    expect(send).not.toHaveBeenCalled()

    stopResolving()
    delivery.forgetSession('session-1')
    resumeResolving()

    attach()
    delivery.onJournalActivity('session-2')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0].sessionId).toBe('session-2')
  })

  it('still drops what the settled worker itself had parked', async () => {
    const { delivery, send, attach, stopResolving } = twoWorkerHarness()
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).not.toHaveBeenCalled()

    // Settlement forgets the identity, so the target no longer resolves — which is exactly why
    // the recorded session id, not a re-resolution, has to be the test.
    stopResolving()
    delivery.forgetSession('session-1')

    attach()
    delivery.onJournalActivity('session-1')
    await flush()
    expect(send).not.toHaveBeenCalled()
  })
})

describe('a mailbox a /clear moves while its send is in flight', () => {
  function clearingHarness(inPlace = false) {
    let contextClearOperationId: string | undefined
    let target = 'session-1'
    const mail = [mailRow('m1', 3, 'dispatch:d1')]
    const pointed = new Set<string>()
    const db = {
      getDispatchContextById: () => ({ run_id: 'run_1' }),
      getUndeliveredUnreadMessages: () => mail.filter((message) => !pointed.has(message.id)),
      getInbox: () => mail.slice(-1),
      getMessageById: (id: string) => {
        const row = mail.find((message) => message.id === id)
        return row && { ...row, read: pointed.has(id) ? 1 : 0 }
      },
      markAsReadAndDelivered: (ids: string[]) => ids.forEach((id) => pointed.add(id)),
      markAsRead: (ids: string[]) => ids.forEach((id) => pointed.add(id)),
      markAsDelivered: () => {}
    }
    let settleHeld: ((state: 'accepted' | 'rejected' | 'throws') => void) | null = null
    let sendAttempts = 0
    const send = vi.fn(
      (_input: Parameters<StructuredMailboxPointerHost['send']>[0]) =>
        new Promise<{ kind: 'sent'; state: 'accepted' | 'rejected' }>((resolve, reject) => {
          if (++sendAttempts === 1) {
            settleHeld = (state) =>
              state === 'throws'
                ? reject(new Error('the operation-admission write failed'))
                : resolve({ kind: 'sent', state })
            return
          }
          resolve({ kind: 'sent', state: 'accepted' })
        })
    )
    const delivery = new OrchestrationStructuredMailboxPointerDelivery({
      getDb: () => db as never,
      getMessageWaiters: () => undefined,
      resolveStructuredTarget: () => ({ sessionId: target, dispatchId: 'd1' }),
      getCliCommand: () => 'orca-dev',
      senderName: () => null,
      host: {
        readSessionFacts: async () => ({ submissions: [] }),
        currentFence: () => 4,
        currentContextClearOperationId: () => contextClearOperationId,
        hasActionablePromptNow: () => false,
        send
      }
    })
    return {
      delivery,
      send,
      pointed,
      clear: () => {
        if (inPlace) {
          contextClearOperationId = 'clear-1'
        } else {
          target = 'clear-successor'
        }
      },
      settle: (state: 'accepted' | 'rejected' | 'throws') => settleHeld?.(state)
    }
  }

  it.each(['rejected', 'throws'] as const)(
    'delivers once to the successor when the old send is then %s, with no further edge',
    async (outcome) => {
      const { delivery, send, pointed, clear, settle } = clearingHarness()
      delivery.deliverForHandle('dispatch:d1')
      await flush()
      clear()
      // The successor's first idle edge lands while the old send is still in flight.
      delivery.deliverForHandle('dispatch:d1')
      await flush()
      expect(send.mock.calls.map(([input]) => input.sessionId)).toEqual(['session-1'])
      settle(outcome)
      await flush()
      await flush()
      expect(send.mock.calls.map(([input]) => input.sessionId)).toEqual([
        'session-1',
        'clear-successor'
      ])
      expect(pointed.has('m1')).toBe(true)
    }
  )

  it.each(['rejected', 'throws'] as const)(
    'delivers once to the fresh context when the in-flight old send is %s',
    async (outcome) => {
      const { delivery, send, pointed, clear, settle } = clearingHarness(true)
      delivery.deliverForHandle('dispatch:d1')
      await flush()
      clear()
      delivery.deliverForHandle('dispatch:d1')
      await flush()
      expect(send).toHaveBeenCalledTimes(1)
      settle(outcome)
      await flush()
      await flush()
      expect(send.mock.calls.map(([input]) => input.sessionId)).toEqual(['session-1', 'session-1'])
      expect(send.mock.calls[1]![0].operationId).not.toBe(send.mock.calls[0]![0].operationId)
      expect(pointed.has('m1')).toBe(true)
    }
  )

  it('keeps an unchanged rejected send parked for the next edge', async () => {
    const { delivery, send, settle } = clearingHarness()
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    settle('rejected')
    await flush()
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
  })
})
