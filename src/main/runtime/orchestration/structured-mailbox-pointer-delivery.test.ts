import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import {
  OrchestrationStructuredMailboxPointerDelivery,
  type StructuredMailboxPointerHost,
  type StructuredPointerSettlement
} from './structured-mailbox-pointer-delivery'
import { formatMessagePointer } from './formatter'
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
  dispatchState?: 'accepted' | 'pending' | 'rejected' | 'unknown'
  /** For a `pending` dispatch: how the admitted turn settles; never, when omitted. */
  settlement?: Promise<StructuredPointerSettlement>
  /** The coordinator of this worker's Run is mid-batch: it checked and has not acked yet. */
  outstandingRunDelivery?: boolean
  outstandingOwnDelivery?: boolean
  /** Undelivered unread rows on the mailbox, oldest first. */
  unreadIds?: string[]
  /** The mailbox this worker owns; its own handle for direct peer mail outside a dispatch. */
  mailbox?: string
  dispatchId?: string | null
  /** Models the host resuming an evicted session: the journal it re-attaches, or null if refused. */
  wakeTo?: AgentJournalRenderItem[] | null
}) {
  const mailbox = options.mailbox ?? 'dispatch:d1'
  const dispatchId = options.dispatchId === undefined ? 'd1' : options.dispatchId
  let journal = options.journal
  const markAsDelivered = vi.fn()
  const send: StructuredMailboxPointerHost['send'] = vi.fn(async () => {
    const state = options.dispatchState ?? 'accepted'
    return state === 'pending'
      ? {
          kind: 'sent' as const,
          state,
          settlement: options.settlement ?? new Promise<StructuredPointerSettlement>(() => {})
        }
      : { kind: 'sent' as const, state }
  })
  const sendMock = vi.mocked(send)
  const markAsUndelivered = vi.fn()
  const released = vi.fn()
  const wake = vi.fn(async () => {
    if (!options.wakeTo) {
      return null
    }
    journal = options.wakeTo
    return released
  })
  const stored = new Map<string, unknown>()
  const db = {
    getDispatchContextById: () => ({ run_id: 'run_1' }),
    // The reader holds `m1` unacknowledged, on whichever mailbox the option names.
    getOutstandingMailboxDelivery: (handle: string) =>
      ((options.outstandingRunDelivery ?? false) && handle.startsWith('run:')) ||
      ((options.outstandingOwnDelivery ?? false) && !handle.startsWith('run:'))
        ? { id: 'delivery_held', messageIds: new Set(['m1']) }
        : undefined,
    getUndeliveredUnreadMessages: () =>
      (options.unreadIds ?? ['m1']).map((id, index) => ({
        id,
        type: 'status',
        sequence: index + 3
      })),
    markAsDelivered,
    markAsUndelivered,
    getStructuredPointerOperation: (key: string) => stored.get(key),
    putStructuredPointerOperation: (row: { mailbox_handle: string }) =>
      stored.set(row.mailbox_handle, row),
    deleteStructuredPointerOperation: (key: string) => stored.delete(key)
  }
  const delivery = new OrchestrationStructuredMailboxPointerDelivery({
    getDb: () => db as never,
    getMessageWaiters: () => undefined,
    resolveStructuredTarget: (mailboxHandle) =>
      mailboxHandle === mailbox ? { sessionId: IDENTITY.sessionId, dispatchId } : null,
    getCliCommand: () => 'orca-dev',
    host: {
      readGateFacts: () => (journal === null ? null : structuredSessionGateFacts(journal)),
      currentFence: () => 4,
      send,
      ...('wakeTo' in options ? { wake } : {})
    }
  })
  return {
    delivery,
    markAsDelivered,
    markAsUndelivered,
    released,
    wake,
    send: sendMock,
    stored,
    setJournal: (next: AgentJournalRenderItem[] | null) => {
      journal = next
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

  it('does not re-point mail the reader already holds unacknowledged', async () => {
    // It already has this batch, so a second pointer spends a whole provider turn telling it
    // something it was told.
    const { delivery, send } = harness({ journal: idleJournal(), outstandingOwnDelivery: true })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).not.toHaveBeenCalled()
  })

  it('points newer mail while the reader holds an unacknowledged batch, in the PTY pointer text', async () => {
    // The strand this pins: a chat reads a result, ends its turn without acking, and the gate on
    // "an unacknowledged batch exists" silenced every later result. The text stays the PTY lane's.
    const { delivery, send, markAsDelivered } = harness({
      journal: idleJournal(),
      outstandingOwnDelivery: true,
      unreadIds: ['m1', 'm2']
    })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0].body.blocks[0]).toMatchObject({
      text: formatMessagePointer(1, 'dispatch:d1', 'orca-dev').trim()
    })
    expect(markAsDelivered).toHaveBeenCalledWith(['m2'])
  })

  it('counts a turn the provider admitted but has not echoed as pointed', async () => {
    const { delivery, markAsDelivered, markAsUndelivered, stored } = harness({
      journal: idleJournal(),
      dispatchState: 'pending'
    })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(markAsDelivered).toHaveBeenCalledWith(['m1'])
    // Unsettled, the claim is still open: its operation id is what a replay would reuse.
    expect(markAsUndelivered).not.toHaveBeenCalled()
    expect(stored.has('dispatch:d1')).toBe(true)
  })

  it('consumes an admitted pointer once its turn is echoed', async () => {
    const { delivery, markAsUndelivered, stored } = harness({
      journal: idleJournal(),
      dispatchState: 'pending',
      settlement: Promise.resolve('accepted')
    })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(markAsUndelivered).not.toHaveBeenCalled()
    expect(stored.has('dispatch:d1')).toBe(false)
  })

  it.each(['unknown', 'rejected'] as const)(
    'gives back an admitted pointer that settles %s, and re-points it as a new send',
    async (settled) => {
      const { delivery, send, markAsDelivered, markAsUndelivered } = harness({
        journal: idleJournal(),
        dispatchState: 'pending',
        settlement: Promise.resolve(settled)
      })
      delivery.deliverForHandle('dispatch:d1')
      await flush()
      expect(markAsDelivered).toHaveBeenCalledWith(['m1'])
      expect(markAsUndelivered).toHaveBeenCalledWith(['m1'])
      const first = send.mock.calls[0]![0].operationId
      // A recorded send replays its verdict and never reaches the provider twice, so the
      // re-point must mint: under the old id it would replay `unknown` and land nothing.
      delivery.onJournalActivity('session-1')
      await flush()
      expect(send).toHaveBeenCalledTimes(2)
      expect(send.mock.calls[1]![0].operationId).not.toBe(first)
    }
  )

  it('leaves a newer batch`s operation row alone when an older pointer settles', async () => {
    let settle: (value: StructuredPointerSettlement) => void = () => {}
    const { delivery, stored } = harness({
      journal: idleJournal(),
      dispatchState: 'pending',
      settlement: new Promise((resolve) => {
        settle = resolve
      })
    })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    const newer = { mailbox_handle: 'dispatch:d1', operation_id: 'newer' }
    stored.set('dispatch:d1', newer)
    settle('unknown')
    await flush()
    expect(stored.get('dispatch:d1')).toBe(newer)
  })

  it('retries a rejected nudge on the next journal edge', async () => {
    // A rejection consumes no mail and nothing else redrives this mailbox, so leaving it unparked
    // stranded the worker until unrelated mail happened to arrive.
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
    expect(send.mock.calls[1]![0].operationId).not.toBe(first)
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

describe('a session the host evicted', () => {
  it('is woken for the delivery, sent the pointer, and handed back to the release clock', async () => {
    // The coordinator case: a chat nobody is looking at is evicted 15s after its last turn, so a
    // worker's result usually arrives to a session with no journal attached and no provider child.
    const { delivery, send, wake, released, markAsDelivered } = harness({
      journal: null,
      mailbox: 'run:run_1',
      dispatchId: null,
      wakeTo: idleJournal()
    })
    expect(delivery.deliverForHandle('run:run_1')).toBe(true)
    await flush()
    expect(wake).toHaveBeenCalledWith(IDENTITY.sessionId)
    expect(send).toHaveBeenCalledTimes(1)
    expect(markAsDelivered).toHaveBeenCalledWith(['m1'])
    expect(released).toHaveBeenCalledTimes(1)
    expect(released.mock.invocationCallOrder[0]).toBeGreaterThan(send.mock.invocationCallOrder[0]!)
  })

  it('retains the mail when the session cannot be resumed', async () => {
    const { delivery, send, markAsDelivered, setJournal } = harness({
      journal: null,
      mailbox: 'run:run_1',
      dispatchId: null,
      wakeTo: null
    })
    delivery.deliverForHandle('run:run_1')
    await flush()
    expect(send).not.toHaveBeenCalled()
    expect(markAsDelivered).not.toHaveBeenCalled()
    // Parked on the session, so its next re-attach retries.
    setJournal(idleJournal())
    delivery.onJournalActivity(IDENTITY.sessionId)
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
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
      getOutstandingMailboxDelivery: () => undefined,
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
        readGateFacts: () => structuredSessionGateFacts(journal),
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
