import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import {
  OrchestrationStructuredMailboxPointerDelivery,
  type StructuredMailboxPointerHost
} from './structured-mailbox-pointer-delivery'
import type { StructuredPointerOperationRow } from './db/messages/structured-pointer-operation-store'
import {
  structuredPointerBatchFingerprint,
  type StructuredPointerSubmission
} from './structured-pointer-operation-id'
import type { DispatchPreambleTurnRow } from './db/dispatch-context/dispatch-preamble-turn-store'
import { structuredSessionGateFacts } from './structured-session-pointer-delivery'
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

function idleJournal(): AgentJournalRenderItem[] {
  return [
    {
      itemId: 'i1',
      observedAt: 1,
      body: { kind: 'status', text: 'done', turnLifecycle: { state: 'completed', turnId: 't1' } }
    } as unknown as AgentJournalRenderItem
  ]
}

function runningJournal(): AgentJournalRenderItem[] {
  return [
    {
      itemId: 'i1',
      observedAt: 1,
      body: { kind: 'status', text: 'working', turnLifecycle: { state: 'running', turnId: 't1' } }
    } as unknown as AgentJournalRenderItem
  ]
}

/** What a worker's journal looks like once it has finished a substantial turn: history, and no
 *  turnLifecycle row anywhere, because settlement tombstones it. */
function settledLongJournal(): AgentJournalRenderItem[] {
  return Array.from(
    { length: 120 },
    (_unused, index) =>
      ({
        itemId: `tool-${index}`,
        observedAt: index,
        body: { kind: 'tool-call', name: 'Bash', input: {}, state: 'completed' }
      }) as unknown as AgentJournalRenderItem
  )
}

/** A prompt raised at the very start of a long turn, far outside any bounded tail window. */
function staleAttentionJournal(): AgentJournalRenderItem[] {
  return [...attentionJournal(), ...settledLongJournal()]
}

function attentionJournal(): AgentJournalRenderItem[] {
  return [
    {
      itemId: 'i1',
      observedAt: 1,
      body: {
        kind: 'question',
        question: 'which?',
        options: [],
        resolution: { state: 'pending' }
      }
    } as unknown as AgentJournalRenderItem
  ]
}

function harness(options: {
  journal: AgentJournalRenderItem[] | null
  dispatchState?: 'accepted' | 'rejected' | 'unknown'
  /** The coordinator of this worker's Run is mid-batch: it checked and has not acked yet. */
  outstandingRunDelivery?: boolean
  outstandingOwnDelivery?: boolean
  /** Undelivered unread rows on the mailbox, oldest first. */
  unread?: { id: string; type: string }[]
  /** A chat assignee's preamble owed on Dispatch d1. */
  preamble?: string
  /** The mailbox this worker owns; its own handle for direct peer mail outside a dispatch. */
  mailbox?: string
  dispatchId?: string | null
}) {
  const mailbox = options.mailbox ?? 'dispatch:d1'
  const dispatchId = options.dispatchId === undefined ? 'd1' : options.dispatchId
  let journal = options.journal
  // The session's recorded sends, as its journal reports them.
  let submissions: StructuredPointerSubmission[] = []
  const markAsDelivered = vi.fn()
  const send: StructuredMailboxPointerHost['send'] = vi.fn(async () => ({
    kind: 'sent' as const,
    state: options.dispatchState ?? ('accepted' as const)
  }))
  const sendMock = vi.mocked(send)
  const stored = new Map<string, StructuredPointerOperationRow>()
  let preambleRow: DispatchPreambleTurnRow | undefined = options.preamble
    ? {
        dispatch_id: 'd1',
        body: options.preamble,
        state: 'owed',
        session_id: null,
        operation_id: null,
        batch_fingerprint: null,
        minted_at_ms: null
      }
    : undefined
  const db = {
    getDispatchContextById: () => ({ run_id: 'run_1' }),
    hasOutstandingMailboxDelivery: (handle: string) =>
      ((options.outstandingRunDelivery ?? false) && handle.startsWith('run:')) ||
      ((options.outstandingOwnDelivery ?? false) && !handle.startsWith('run:')),
    getUndeliveredUnreadMessages: () =>
      (options.unread ?? [{ id: 'm1', type: 'status' }]).map((message, index) => ({
        ...message,
        sequence: index + 3
      })),
    markAsDelivered,
    getDispatchPreambleTurn: (id: string) =>
      preambleRow?.dispatch_id === id ? preambleRow : undefined,
    claimDispatchPreambleTurnSend: (id: string) => {
      if (preambleRow?.dispatch_id !== id || preambleRow.state === 'delivered') {
        return false
      }
      preambleRow = { ...preambleRow, state: 'sending' }
      return true
    },
    recordDispatchPreambleTurnOperation: (
      id: string,
      operation: Omit<StructuredPointerOperationRow, 'mailbox_handle'>
    ) => {
      if (preambleRow?.dispatch_id === id && preambleRow.state !== 'delivered') {
        preambleRow = { ...preambleRow, ...operation }
      }
    },
    settleDispatchPreambleTurnSend: (id: string, state: DispatchPreambleTurnRow['state']) => {
      if (preambleRow?.dispatch_id === id) {
        preambleRow = { ...preambleRow, state }
      }
    },
    getStructuredPointerOperation: (key: string) => stored.get(key),
    putStructuredPointerOperation: (row: StructuredPointerOperationRow) =>
      stored.set(row.mailbox_handle, row),
    deleteStructuredPointerOperation: (key: string) => stored.delete(key)
  }
  const lane = () =>
    new OrchestrationStructuredMailboxPointerDelivery({
      getDb: () => db as never,
      getMessageWaiters: () => undefined,
      resolveStructuredTarget: (mailboxHandle) =>
        mailboxHandle === mailbox ? { sessionId: IDENTITY.sessionId, dispatchId } : null,
      getCliCommand: () => 'orca-dev',
      host: {
        readGateFacts: async () =>
          journal === null ? null : { ...structuredSessionGateFacts(journal), submissions },
        currentFence: () => 4,
        send
      }
    })
  let delivery = lane()
  return {
    get delivery() {
      return delivery
    },
    /** A new process over the same database: nothing the lane kept in memory survives. */
    restart: () => {
      delivery = lane()
    },
    markAsDelivered,
    preambleState: () => preambleRow?.state,
    preambleOperationId: () => preambleRow?.operation_id ?? null,
    send: sendMock,
    stored,
    setJournal: (next: AgentJournalRenderItem[] | null) => {
      journal = next
    },
    setSubmissions: (next: StructuredPointerSubmission[]) => {
      submissions = next
    }
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('structured mailbox pointer delivery', () => {
  it('claims only mailboxes whose assignee is a structured worker', () => {
    const { delivery } = harness({ journal: idleJournal() })
    expect(delivery.deliverForHandle('dispatch:d1')).toBe(true)
    expect(delivery.deliverForHandle('run:run_1')).toBe(false)
  })

  it('sends the pointer as a turn and consumes mail on an accepted dispatch', async () => {
    const { delivery, markAsDelivered, send } = harness({ journal: idleJournal() })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0].operationId).toMatch(/^\d{13}-[0-9a-f]{32}$/)
    expect(markAsDelivered).toHaveBeenCalledWith(['m1'])
  })

  it('nudges through the worker`s own handle for direct peer mail outside a dispatch', async () => {
    const { delivery, send, markAsDelivered } = harness({
      journal: idleJournal(),
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
      journal: idleJournal(),
      dispatchState: 'unknown'
    })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(markAsDelivered).not.toHaveBeenCalled()
  })

  it('retains mail while a turn is running', async () => {
    const { delivery, send, markAsDelivered } = harness({ journal: runningJournal() })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).not.toHaveBeenCalled()
    expect(markAsDelivered).not.toHaveBeenCalled()
  })

  it('retains mail while a prompt is waiting for a human', async () => {
    const { delivery, send } = harness({ journal: attentionJournal() })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).not.toHaveBeenCalled()
  })

  it('delivers to a worker whose finished turn left a long history and no lifecycle row', async () => {
    // The steady state after a worker's first substantial turn. Gating on a bounded tail page read
    // this as permanently busy, so every later nudge parked forever and the worker went unnudged.
    const { delivery, send, markAsDelivered } = harness({ journal: settledLongJournal() })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(markAsDelivered).toHaveBeenCalledWith(['m1'])
  })

  it('retains mail for a prompt that scrolled out of the tail window', async () => {
    const { delivery, send } = harness({ journal: staleAttentionJournal() })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).not.toHaveBeenCalled()
  })

  it('retains mail when the session is not attached', async () => {
    const { delivery, send } = harness({ journal: null })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).not.toHaveBeenCalled()
  })

  it('redrives a detached session when the journal replays on re-attach', async () => {
    // A transient detach parks nothing to be woken unless `session-not-attached` waits for the
    // journal edge, and the dispatch preamble tells the worker not to poll.
    const { delivery, send, setJournal, markAsDelivered } = harness({ journal: null })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).not.toHaveBeenCalled()
    setJournal(idleJournal())
    delivery.onJournalActivity('session-1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(markAsDelivered).toHaveBeenCalledWith(['m1'])
  })

  it('retries a parked pointer when the journal moves', async () => {
    const { delivery, send, setJournal, markAsDelivered } = harness({ journal: runningJournal() })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).not.toHaveBeenCalled()
    setJournal(idleJournal())
    delivery.onJournalActivity('session-1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(markAsDelivered).toHaveBeenCalledWith(['m1'])
  })

  it('nudges the worker while its coordinator holds an unacked Run delivery', async () => {
    // The exact window in which a coordinator replies to its workers: it checked, is acting on the
    // batch, and has not acked yet. The gate is keyed on the handle being nudged, so the
    // coordinator's `run:` delivery is invisible here — gating the WORKER's dispatch mailbox on it
    // dropped the nudge with nothing parked, and the worker sat idle on mail it was never told of.
    const { delivery, send, markAsDelivered } = harness({
      journal: idleJournal(),
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
    const { delivery, send } = harness({ journal: idleJournal(), outstandingOwnDelivery: true })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).not.toHaveBeenCalled()
  })

  it('retries a rejected nudge on the next journal edge, under the same id', async () => {
    // A rejection consumes no mail and nothing else redrives this mailbox, so leaving it unparked
    // stranded the worker until unrelated mail happened to arrive. The retry keeps the id: the host
    // replays a recorded refusal rather than starting the agent again.
    const { delivery, send, markAsDelivered } = harness({
      journal: idleJournal(),
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
      journal: idleJournal(),
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
      journal: idleJournal(),
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
        journal: idleJournal(),
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
        journal: idleJournal(),
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
      journal: idleJournal(),
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
      journal: idleJournal(),
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
  /** Two workers, each mid-turn and so each parked on its OWN session's journal edge. */
  function twoWorkerHarness() {
    let resolves = true
    let journal = runningJournal()
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
      getUndeliveredUnreadMessages: () => [{ id: 'm1', type: 'status', sequence: 3 }],
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
      host: {
        readGateFacts: async () => ({ ...structuredSessionGateFacts(journal), submissions: [] }),
        currentFence: () => 4,
        send
      }
    })
    return {
      delivery,
      send: vi.mocked(send),
      goIdle: () => {
        journal = idleJournal()
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
    const { delivery, send, goIdle, stopResolving, resumeResolving } = twoWorkerHarness()
    delivery.deliverForHandle('dispatch:d1')
    delivery.deliverForHandle('dispatch:d2')
    await flush()
    expect(send).not.toHaveBeenCalled()

    stopResolving()
    delivery.forgetSession('session-1')
    resumeResolving()

    goIdle()
    delivery.onJournalActivity('session-2')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0].sessionId).toBe('session-2')
  })

  it('still drops what the settled worker itself had parked', async () => {
    const { delivery, send, goIdle, stopResolving } = twoWorkerHarness()
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).not.toHaveBeenCalled()

    // Settlement forgets the identity, so the target no longer resolves — which is exactly why
    // the recorded session id, not a re-resolution, has to be the test.
    stopResolving()
    delivery.forgetSession('session-1')

    goIdle()
    delivery.onJournalActivity('session-1')
    await flush()
    expect(send).not.toHaveBeenCalled()
  })
})

describe("a chat assignee's dispatch preamble", () => {
  const PREAMBLE = 'You are a dispatched worker.'
  const sentText = (h: ReturnType<typeof harness>, call: number) =>
    h.send.mock.calls[call]![0].body.blocks

  it('goes first, alone and as its own body; the mail behind it is pointed at the next edge', async () => {
    const h = harness({ journal: idleJournal(), preamble: PREAMBLE })
    h.delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(sentText(h, 0)).toEqual([{ type: 'text', text: PREAMBLE }])
    expect(h.preambleState()).toBe('delivered')
    expect(h.markAsDelivered).not.toHaveBeenCalled()

    h.delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(sentText(h, 1)).toEqual([
      { type: 'text', text: expect.stringContaining('orchestration message') }
    ])
    expect(h.markAsDelivered).toHaveBeenCalledWith(['m1'])
  })

  it('is sent although the chat holds an unacknowledged check batch on its Dispatch mailbox', async () => {
    const h = harness({ journal: idleJournal(), preamble: PREAMBLE, outstandingOwnDelivery: true })
    h.delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(sentText(h, 0)).toEqual([{ type: 'text', text: PREAMBLE }])
  })

  it('gives `dispatch`-typed mail the pointer, never its body', async () => {
    const h = harness({ journal: idleJournal(), unread: [{ id: 'msg_forged', type: 'dispatch' }] })
    h.delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(sentText(h, 0)).toEqual([
      { type: 'text', text: expect.stringContaining('orchestration message') }
    ])
  })

  it('is in doubt while a send it stopped waiting on is unknown, and delivered once echoed', async () => {
    const h = harness({ journal: idleJournal(), preamble: PREAMBLE, dispatchState: 'unknown' })
    h.delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(h.preambleState()).toBe('in_doubt')
    const first = h.send.mock.calls[0]![0].operationId
    h.setSubmissions([
      { clientMessageId: first, dispatchState: 'accepted', submittedAt: Date.now() }
    ])
    h.delivery.onJournalActivity(IDENTITY.sessionId)
    await flush()
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.preambleState()).toBe('delivered')
  })

  it('replays a refused send under its own id, and goes again only after a later turn runs', async () => {
    const h = harness({ journal: idleJournal(), preamble: PREAMBLE, dispatchState: 'rejected' })
    h.delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(h.preambleState()).toBe('owed')
    const first = h.send.mock.calls[0]![0].operationId
    h.setSubmissions([
      { clientMessageId: first, dispatchState: 'rejected', submittedAt: Date.now() }
    ])
    for (let edge = 0; edge < 3; edge++) {
      h.delivery.onJournalActivity(IDENTITY.sessionId)
      await flush()
    }
    // The host answers a recorded id from its ledger and starts nothing: no respawn loop.
    expect(h.send.mock.calls.map(([input]) => input.operationId)).toEqual([
      first,
      first,
      first,
      first
    ])

    h.setSubmissions([
      { clientMessageId: first, dispatchState: 'rejected', submittedAt: Date.now() },
      { clientMessageId: 'user-turn', dispatchState: 'accepted', submittedAt: Date.now() + 1 }
    ])
    h.delivery.onJournalActivity(IDENTITY.sessionId)
    await flush()
    expect(h.send.mock.calls.at(-1)![0].operationId).not.toBe(first)
  })

  it('replays a send left in doubt under its own id after a restart, never sending the task again', async () => {
    const h = harness({ journal: idleJournal(), preamble: PREAMBLE, dispatchState: 'unknown' })
    h.delivery.deliverForHandle('dispatch:d1')
    await flush()
    const first = h.send.mock.calls[0]![0].operationId
    // Restart recovery leaves the in-flight send `unknown`; the startup scan redrives the row.
    h.setSubmissions([
      { clientMessageId: first, dispatchState: 'unknown', submittedAt: Date.now() }
    ])
    h.restart()
    h.delivery.deliverForHandle('dispatch:d1')
    await flush()
    // The host answers a recorded id from its ledger and starts nothing.
    expect(h.send.mock.calls.map(([input]) => input.operationId)).toEqual([first, first])
  })

  it('keeps its operation id on its own row, never in the mailbox ledger a mail reset clears', async () => {
    const h = harness({ journal: idleJournal(), preamble: PREAMBLE, dispatchState: 'unknown' })
    h.delivery.deliverForHandle('dispatch:d1')
    await flush()
    const first = h.send.mock.calls[0]![0].operationId
    expect(h.preambleOperationId()).toBe(first)
    expect(h.stored.get('dispatch:d1')).toBeUndefined()

    // A mail reset clears the ledger, and the preamble still replays under its own id.
    h.stored.clear()
    h.delivery.onJournalActivity(IDENTITY.sessionId)
    await flush()
    expect(h.send.mock.calls.map(([input]) => input.operationId)).toEqual([first, first])
  })

  it('waits out a running turn like any mail', async () => {
    const h = harness({ journal: runningJournal(), preamble: PREAMBLE })
    h.delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(h.send).not.toHaveBeenCalled()
    h.setJournal(idleJournal())
    h.delivery.onJournalActivity(IDENTITY.sessionId)
    await flush()
    expect(sentText(h, 0)).toEqual([{ type: 'text', text: PREAMBLE }])
  })
})
