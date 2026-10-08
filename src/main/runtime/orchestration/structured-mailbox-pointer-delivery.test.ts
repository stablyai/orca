import { describe, expect, it, vi } from 'vitest'
import {
  OrchestrationStructuredMailboxPointerDelivery,
  type StructuredMailboxPointerHost
} from './structured-mailbox-pointer-delivery'
import type { StructuredPointerOperationRow } from './db/messages/structured-pointer-operation-store'
import {
  structuredPointerBatchFingerprint,
  type StructuredPointerSubmission
} from './structured-pointer-operation-id'
import type { StructuredWorkerIdentity } from '../structured-worker-identity'

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
  /** The chat was busy: its queue holds the pointer as a card. */
  queued?: true
  /** The coordinator of this worker's Run is mid-batch: it checked and has not acked yet. */
  outstandingRunDelivery?: boolean
  outstandingOwnDelivery?: boolean
  /** The mailbox this worker owns; its own handle for direct peer mail outside a dispatch. */
  mailbox?: string
  dispatchId?: string | null
}) {
  const mailbox = options.mailbox ?? 'dispatch:d1'
  const dispatchId = options.dispatchId === undefined ? 'd1' : options.dispatchId
  let attached = options.attached ?? true
  // The session's recorded sends, as its journal reports them.
  let submissions: StructuredPointerSubmission[] = []
  // The mailbox's unread mail; a pointed message is no longer selected for a pointer.
  const mail = [
    { id: 'm1', type: 'status', sequence: 3, from_handle: 'term_coord', run_id: 'run_1' }
  ]
  const pointed = new Set<string>()
  const markAsDelivered = vi.fn((ids: string[]) => {
    for (const id of ids) {
      pointed.add(id)
    }
  })
  const send: StructuredMailboxPointerHost['send'] = vi.fn(async () =>
    options.queued
      ? { kind: 'queued' as const }
      : { kind: 'sent' as const, state: options.dispatchState ?? ('accepted' as const) }
  )
  const sendMock = vi.mocked(send)
  const stored = new Map<string, StructuredPointerOperationRow>()
  const db = {
    getDispatchContextById: () => ({ run_id: 'run_1' }),
    hasOutstandingMailboxDelivery: (handle: string) =>
      ((options.outstandingRunDelivery ?? false) && handle.startsWith('run:')) ||
      ((options.outstandingOwnDelivery ?? false) && !handle.startsWith('run:')),
    getUndeliveredUnreadMessages: () => mail.filter((message) => !pointed.has(message.id)),
    markAsDelivered,
    getStructuredPointerOperation: (key: string) => stored.get(key),
    putStructuredPointerOperation: (row: StructuredPointerOperationRow) =>
      stored.set(row.mailbox_handle, row),
    deleteStructuredPointerOperation: (key: string) => stored.delete(key)
  }
  const delivery = new OrchestrationStructuredMailboxPointerDelivery({
    getDb: () => db as never,
    getMessageWaiters: () => undefined,
    resolveStructuredTarget: (mailboxHandle) =>
      mailboxHandle === mailbox ? { sessionId: IDENTITY.sessionId, dispatchId } : null,
    getCliCommand: () => 'orca-dev',
    senderName: (party) => (party.address === 'term_coord' ? 'Coordinator' : null),
    host: {
      readSessionFacts: async () => (attached ? { submissions } : null),
      currentFence: () => 4,
      send
    }
  })
  return {
    delivery,
    markAsDelivered,
    send: sendMock,
    stored,
    setAttached: (next: boolean) => {
      attached = next
    },
    receive: (id: string, sequence: number) => {
      mail.push({ id, type: 'status', sequence, from_handle: 'term_coord', run_id: 'run_1' })
    },
    setSubmissions: (next: StructuredPointerSubmission[]) => {
      submissions = next
    }
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('structured mailbox pointer delivery', () => {
  it('claims only mailboxes whose assignee is a structured worker', () => {
    const { delivery } = harness({})
    expect(delivery.deliverForHandle('dispatch:d1')).toBe(true)
    expect(delivery.deliverForHandle('run:run_1')).toBe(false)
  })

  it('sends the pointer as a turn and consumes mail on an accepted dispatch', async () => {
    const { delivery, markAsDelivered, send } = harness({})
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0].operationId).toMatch(/^\d{13}-[0-9a-f]{32}$/)
    expect(markAsDelivered).toHaveBeenCalledWith(['m1'])
  })

  it('nudges through the worker`s own handle for direct peer mail outside a dispatch', async () => {
    const { delivery, send, markAsDelivered } = harness({
      mailbox: IDENTITY.handle,
      dispatchId: null
    })
    expect(delivery.deliverForHandle(IDENTITY.handle)).toBe(true)
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0].dispatchId).toBeNull()
    // A plain `check`, with no `--run`: the worker resolves its OWN mailbox by identity, and for a
    // worker outside a dispatch that is the direct mailbox this mail is sitting in. Pointing it at
    // a run would send it to read a coordinator mailbox that has nothing waiting.
    expect(send.mock.calls[0]![0].body.blocks[0]).toMatchObject({
      text: expect.not.stringContaining('--run')
    })
    expect(markAsDelivered).toHaveBeenCalledWith(['m1'])
  })

  it('retains mail when the dispatch settles unknown', async () => {
    const { delivery, markAsDelivered } = harness({
      dispatchState: 'unknown'
    })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(markAsDelivered).not.toHaveBeenCalled()
  })

  it('retains mail when the session is not attached', async () => {
    const { delivery, send } = harness({ attached: false })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).not.toHaveBeenCalled()
  })

  it('redrives a detached session when the journal replays on re-attach', async () => {
    // A transient detach parks nothing to be woken unless `session-not-attached` waits for the
    // journal edge, and the dispatch preamble tells the worker not to poll.
    const { delivery, send, setAttached, markAsDelivered } = harness({ attached: false })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).not.toHaveBeenCalled()
    setAttached(true)
    delivery.onJournalActivity('session-1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(markAsDelivered).toHaveBeenCalledWith(['m1'])
  })

  it('sends the pointer through the chat, with who it is from, and counts it pointed once queued', async () => {
    const { delivery, send, markAsDelivered, stored } = harness({ queued: true })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0].body.blocks[0]).toMatchObject({
      text: expect.stringContaining('orca-dev orchestration check')
    })
    expect(send.mock.calls[0]![0].body.from).toMatchObject({
      kind: 'agent',
      senders: [{ party: { address: 'term_coord' }, name: 'Coordinator' }],
      orchestration: {
        message: 'mail-notice',
        mailbox: 'dispatch:d1',
        messages: [{ messageId: 'm1', runId: 'run_1', from: 'term_coord' }]
      }
    })
    // The chat's queue holds it now, as it holds the person's: the same mail is not pointed again.
    expect(markAsDelivered).toHaveBeenCalledWith(['m1'])
    expect(stored.has('dispatch:d1')).toBe(false)
  })

  it('points mail that arrives while earlier pointed mail is still unread, counting only the new mail', async () => {
    const { delivery, send, receive } = harness({})
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    receive('m2', 4)
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]![0].body.blocks[0]).toMatchObject({
      text: expect.stringContaining('You have 1 orchestration message.')
    })
  })

  it('nudges the worker while its coordinator holds an unacked Run delivery', async () => {
    // The exact window in which a coordinator replies to its workers: it checked, is acting on the
    // batch, and has not acked yet. The gate is keyed on the handle being nudged, so the
    // coordinator's `run:` delivery is invisible here — gating the WORKER's dispatch mailbox on it
    // dropped the nudge with nothing parked, and the worker sat idle on mail it was never told of.
    const { delivery, send, markAsDelivered } = harness({
      outstandingRunDelivery: true
    })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(markAsDelivered).toHaveBeenCalledWith(['m1'])
  })

  it('does not re-nudge a mailbox still holding its own unacked batch', async () => {
    // The other half of the same gate: the consumer already has this batch, so a second nudge
    // spends a whole provider turn telling it something it was told.
    const { delivery, send } = harness({ outstandingOwnDelivery: true })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).not.toHaveBeenCalled()
  })

  it('retries a rejected nudge on the next journal edge, under the same id', async () => {
    // A rejection consumes no mail and nothing else redrives this mailbox, so leaving it unparked
    // stranded the worker until unrelated mail happened to arrive. The retry keeps the id: the host
    // replays a recorded refusal rather than starting the agent again.
    const { delivery, send, markAsDelivered } = harness({
      dispatchState: 'rejected'
    })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(markAsDelivered).not.toHaveBeenCalled()
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

  it('points once more under a new id for a send an earlier process left in doubt', async () => {
    const { delivery, send, stored, setSubmissions } = harness({
      dispatchState: 'unknown'
    })
    stored.set('dispatch:d1', {
      mailbox_handle: 'dispatch:d1',
      session_id: 'session-1',
      operation_id: 'earlier-process-op',
      batch_fingerprint: structuredPointerBatchFingerprint('session-1', ['m1']),
      minted_at_ms: 0
    })
    setSubmissions([
      { clientMessageId: 'earlier-process-op', dispatchState: 'unknown', submittedAt: Date.now() }
    ])
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    const reminted = send.mock.calls[0]![0].operationId
    expect(reminted).not.toBe('earlier-process-op')
    // Minted by this process, the new id replays from here on.
    setSubmissions([
      { clientMessageId: 'earlier-process-op', dispatchState: 'unknown', submittedAt: Date.now() },
      { clientMessageId: reminted, dispatchState: 'unknown', submittedAt: Date.now() }
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

  it('does not read a turn from before a backward clock step as one that ran after its pointer', async () => {
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

  it('stamps a pointer whose echo arrived after the lane stopped waiting, sending nothing more', async () => {
    const { delivery, send, markAsDelivered, stored, setSubmissions } = harness({
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
    expect(markAsDelivered).toHaveBeenCalledWith(['m1'])
    expect(stored.has('dispatch:d1')).toBe(false)
  })

  it('reuses one operation id for the same batch and re-mints when it grows', async () => {
    const { delivery, send, stored } = harness({
      dispatchState: 'unknown'
    })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    const first = send.mock.calls[0]![0].operationId
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send.mock.calls[1]![0].operationId).toBe(first)
    stored.clear()
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send.mock.calls[2]![0].operationId).not.toBe(first)
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
      hasOutstandingMailboxDelivery: () => false,
      getUndeliveredUnreadMessages: () => [
        { id: 'm1', type: 'status', sequence: 3, from_handle: 'term_coord', run_id: 'run_1' }
      ],
      markAsDelivered: vi.fn(),
      getStructuredPointerOperation: () => undefined,
      putStructuredPointerOperation: () => {},
      deleteStructuredPointerOperation: () => {}
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

describe('a mailbox a /clear moves while its nudge is in flight', () => {
  function clearingHarness() {
    let target = 'session-1'
    const mail = [
      { id: 'm1', type: 'status', sequence: 3, from_handle: 'term_coord', run_id: 'run_1' }
    ]
    const pointed = new Set<string>()
    const stored = new Map<string, StructuredPointerOperationRow>()
    const db = {
      getDispatchContextById: () => ({ run_id: 'run_1' }),
      hasOutstandingMailboxDelivery: () => false,
      getUndeliveredUnreadMessages: () => mail.filter((message) => !pointed.has(message.id)),
      markAsDelivered: (ids: string[]) => ids.forEach((id) => pointed.add(id)),
      getStructuredPointerOperation: (key: string) => stored.get(key),
      putStructuredPointerOperation: (row: StructuredPointerOperationRow) =>
        stored.set(row.mailbox_handle, row),
      deleteStructuredPointerOperation: (key: string) => stored.delete(key)
    }
    let settleHeld: ((state: 'accepted' | 'rejected' | 'throws') => void) | null = null
    const send = vi.fn(
      ({ sessionId }: { sessionId: string }) =>
        new Promise<{ kind: 'sent'; state: 'accepted' | 'rejected' }>((resolve, reject) => {
          if (sessionId === 'session-1') {
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
        send
      }
    })
    return {
      delivery,
      send,
      pointed,
      clear: () => {
        target = 'clear-successor'
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
      // The successor's first idle edge lands while the old nudge is still in flight.
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

  it('keeps an unchanged rejected nudge parked for the next edge', async () => {
    const { delivery, send, settle } = clearingHarness()
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    settle('rejected')
    await flush()
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
  })
})
