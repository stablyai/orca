// A Stop accepts through its own command receipt, saved before it acts: its target is captured as
// it is accepted, the sends still queued are withdrawn in the same transaction, and a retry of its
// id is answered from the receipt without resolving a target again.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type { JournalStopEvent } from '../agent-session-journal/journal-row-schema'
import { JournalStopAcceptor } from '../agent-session-journal/journal-stop-acceptance'
import { structuredAgentSessionNamedTurnScope } from './structured-agent-session-turn-stop-notes'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

const CALLER_SCOPE = { kind: 'caller', callerKey: CALLER.callerKey } as const

let rig: QueuedMessageTestRig
let serial = 0

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(() => rig.dispose())

function opId(): string {
  serial += 1
  return `${NOW}-${serial.toString(16).padStart(32, 'f')}`
}

function journal() {
  const open = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!open) {
    throw new Error('expected the conversation open')
  }
  return open
}

function receipt(id: string) {
  return rig.store.readCommandReceipt(CALLER_SCOPE, id)
}

/** Every Stop event in the live epoch, with where it landed, oldest first. */
function stopEvents(): { sequence: number; event: JournalStopEvent }[] {
  const since = journal().readSince({ epoch: journal().epoch, sequence: 0 })
  if (!since.ok) {
    throw new Error(`expected rows, got reset ${since.reset}`)
  }
  return since.rows.flatMap((row) =>
    row.kind === 'tombstone' && row.stopEvent ? [{ sequence: row.seq, event: row.stopEvent }] : []
  )
}

/** The provider's row for a turn, as it lands while the agent works. */
async function turnRow(turnId: string, state: 'running' | 'interrupted'): Promise<void> {
  await journal().appendItem(
    { provider: 'codex', threadId: 'thread-1', turnId, ordinal: 900 },
    {
      kind: 'turn',
      turnId,
      state,
      startedAt: 1,
      ...(state === 'running' ? {} : { completedAt: 2 })
    },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

function namedStop(turnId: string, id = opId()) {
  return rig.host.cancel(CALLER, {
    envelope: rig.envelope({ turnId }, 'agentSession.cancel', id),
    turnId
  })
}

/** A person's send accepted behind the working turn, not yet handed over. */
async function queuedSend(text: string): Promise<string> {
  const { id, result } = rig.send(text)
  await result
  const accepted = await rig.submission(id)
  expect(accepted && isQueuedAgentJournalSubmission(accepted)).toBe(true)
  return id
}

describe('a retry of the same id', () => {
  it('is answered from the receipt, with one Stop effect, when sent again', async () => {
    await rig.workingSend()
    const id = opId()
    expect(await rig.stop(id)).toMatchObject({ ok: true, replayed: false })
    expect(await rig.stop(id)).toMatchObject({
      ok: true,
      replayed: true,
      value: { cancelled: false }
    })
    expect(rig.cancelTurn).toHaveBeenCalledOnce()
    const [mark] = stopEvents()
    expect(stopEvents()).toHaveLength(1)
    // The receipt points at the Stop's own event.
    expect(receipt(id)).toMatchObject({
      verdict: 'readable',
      receipt: {
        method: 'agentSession.cancel',
        result: { kind: 'journal-row', epoch: journal().epoch, sequence: mark?.sequence }
      }
    })
  })

  it('is answered from the receipt, with one Stop effect, when both arrive at once', async () => {
    await rig.workingSend()
    const id = opId()
    const answers = await Promise.all([rig.stop(id), rig.stop(id)])
    expect(answers.map((answer) => answer.ok && answer.replayed).toSorted()).toEqual([false, true])
    expect(rig.cancelTurn).toHaveBeenCalledOnce()
    expect(stopEvents()).toHaveLength(1)
  })

  it('after a newer turn started interrupts nothing and withdraws nothing', async () => {
    const working = await rig.workingSend()
    await turnRow('turn-1', 'running')
    const id = opId()
    await rig.stop(id)
    await turnRow('turn-1', 'interrupted')
    await rig.settleAccepted(working, 'stopped')
    const newer = await rig.workingSend()
    await turnRow('turn-2', 'running')
    const behind = await queuedSend('queued behind the newer turn')

    expect(await rig.stop(id)).toMatchObject({ ok: true, replayed: true })

    expect(rig.cancelTurn).toHaveBeenCalledOnce()
    expect(stopEvents()).toHaveLength(1)
    expect(journal().activeTurnId()).toBe('turn-2')
    expect((await rig.submission(behind))?.dispatchState).not.toBe('rejected')
    expect((await rig.submission(newer))?.dispatchState).not.toBe('rejected')
    expect(await rig.drafts()).toEqual([])
  })
})

describe('what a Stop captures as it is accepted', () => {
  // Hand-over runs only on the session's lane, which the Stop holds: a turn that opens while its
  // save waits is from a send made before the Stop, and the Stop stops it.
  it('a target-less Stop interrupts the turn that opened while its save waited', async () => {
    await rig.workingSend()
    await turnRow('turn-1', 'running')
    const saving = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const accept = JournalStopAcceptor.prototype.accept
    vi.spyOn(JournalStopAcceptor.prototype, 'accept').mockImplementation(async function (
      this: JournalStopAcceptor,
      ...args
    ) {
      entered.resolve()
      await saving.promise
      return accept.apply(this, args)
    })
    const stopping = rig.stop()
    await entered.promise
    await turnRow('turn-1', 'interrupted')
    await turnRow('turn-2', 'running')
    saving.resolve()

    expect(await stopping).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(rig.cancelTurn).toHaveBeenCalledOnce()
    // As where its event is written: it names the turn live then, the one it stopped, never one
    // that had already ended.
    expect(stopEvents()).toEqual([
      expect.objectContaining({ event: expect.objectContaining({ turnId: 'turn-2' }) })
    ])
    const note = journal()
      .snapshot()
      .items.find((item) => item.body.kind === 'status')
    expect(note?.turnScope).toEqual(structuredAgentSessionNamedTurnScope(journal(), 'turn-2'))
  })

  it('a target-less Stop names the live turn, and its retry after a new turn does nothing', async () => {
    const working = await rig.workingSend()
    await turnRow('turn-1', 'running')
    const id = opId()
    expect(await rig.stop(id)).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(stopEvents()).toEqual([
      expect.objectContaining({ event: expect.objectContaining({ turnId: 'turn-1' }) })
    ])
    await turnRow('turn-1', 'interrupted')
    await rig.settleAccepted(working, 'stopped')
    await rig.workingSend()
    await turnRow('turn-2', 'running')

    expect(await rig.stop(id)).toMatchObject({ ok: true, replayed: true })
    expect(rig.cancelTurn).toHaveBeenCalledOnce()
    expect(journal().activeTurnId()).toBe('turn-2')
  })

  it('a Stop naming a turn already over is a no-op, its receipt committed before the answer', async () => {
    const id = opId()
    expect(await namedStop('turn-gone', id)).toMatchObject({
      ok: true,
      replayed: false,
      value: { turnId: 'turn-gone', cancelled: false }
    })
    expect(receipt(id)).toMatchObject({
      verdict: 'readable',
      receipt: {
        result: {
          kind: 'no-op',
          outcome: { kind: 'cancel', cancelled: false, turnId: 'turn-gone' }
        }
      }
    })
    expect(rig.cancelTurn).not.toHaveBeenCalled()
    expect(stopEvents()).toEqual([])
  })

  // A rewind removes the turn's row, so the journal no longer shows it: it is still over, never a
  // turn that may be opening while the next send works.
  it('a Stop naming a turn a rewind removed is late while the next send opens its turn', async () => {
    await rig.workingSend()
    await turnRow('turn-1', 'running')
    await turnRow('turn-1', 'interrupted')
    await journal().appendTombstone(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 900 },
      { fence: 1 }
    )
    expect(journal().activeTurnId()).toBeNull()

    expect(await namedStop('turn-1')).toMatchObject({
      ok: true,
      value: { turnId: 'turn-1', cancelled: false }
    })
    expect(rig.cancelTurn).not.toHaveBeenCalled()
    expect(stopEvents()).toEqual([])
  })

  it('a Stop naming a turn already over withdraws none of what a newer turn queued', async () => {
    await rig.workingSend()
    await turnRow('turn-new', 'running')
    const behind = await queuedSend('queued behind the newer turn')

    expect(await namedStop('turn-old')).toMatchObject({ ok: true, value: { cancelled: false } })

    expect(rig.cancelTurn).not.toHaveBeenCalled()
    expect(stopEvents()).toEqual([])
    expect(await rig.submission(behind)).toMatchObject({ dispatchState: 'pending' })
    expect(await rig.drafts()).toEqual([])
  })
})

describe('the sends a Stop withdraws', () => {
  it('withdraws each queued send in the transaction that writes its event', async () => {
    const working = await rig.workingSend()
    const queued = await queuedSend('queued behind the turn')

    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })

    expect(await rig.submission(queued)).toMatchObject({
      dispatchState: 'rejected',
      rejection: { kind: 'cancelled' }
    })
    expect((await rig.submission(queued))?.keptAsQueuedMessageId).toBeUndefined()
    expect(await rig.drafts()).toEqual([])
    await rig.settleAccepted(working, 'stopped')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(await rig.handoff(queued)).toBeUndefined()
  })

  it('does not withdraw a send that arrives after it: that one runs once the Stop lands', async () => {
    const working = await rig.workingSend()
    const queued = await queuedSend('queued before the stop')
    await rig.stop()
    const after = rig.send('sent after the stop')
    await after.result

    expect(await rig.submission(after.id)).toMatchObject({ dispatchState: 'pending' })
    await rig.settleAccepted(working, 'stopped')
    await eventually(async () =>
      expect((await rig.submission(after.id))?.handedOverAt).toBeDefined()
    )
    expect((await rig.submission(after.id))?.keptAsQueuedMessageId).toBeUndefined()
    expect(await rig.submission(queued)).toMatchObject({ rejection: { kind: 'cancelled' } })
  })
})

describe('a Stop that cannot be saved', () => {
  it('refuses in plain words and interrupts nothing, withdrawing nothing', async () => {
    await rig.workingSend()
    const queued = await queuedSend('queued behind the turn')
    const db = openTestJournalHostDatabase(rig.root).db
    db.exec(`CREATE TRIGGER fail_stop_receipt BEFORE INSERT ON agent_session_command_receipts
      BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END`)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(await rig.stop()).toMatchObject({
        ok: false,
        refusal: {
          code: 'agent_session_operation_invalid',
          details: { reason: 'stopFailed', agent: 'codex' },
          message: expect.stringMatching(/^Couldn't stop .+\. Try again\.$/)
        }
      })
    } finally {
      db.exec('DROP TRIGGER fail_stop_receipt')
    }
    expect(rig.cancelTurn).not.toHaveBeenCalled()
    expect(stopEvents()).toEqual([])
    expect(await rig.submission(queued)).toMatchObject({ dispatchState: 'pending' })
    expect(await rig.drafts()).toEqual([])
  })

  it('answers unknown from a receipt it cannot read, interrupting nothing', async () => {
    await rig.workingSend()
    const id = opId()
    openTestJournalHostDatabase(rig.root)
      .db.prepare(
        `INSERT INTO agent_session_command_receipts (operation_id, session_id, caller_key, method,
          fingerprint, status, result_json, rejection_json, accepted_at)
         VALUES (?, ?, ?, 'agentSession.cancel', 'x', 'accepted', '{', NULL, 0)`
      )
      .run(id, SESSION, CALLER.callerKey)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(await rig.stop(id)).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_unknown' }
    })
    expect(rig.cancelTurn).not.toHaveBeenCalled()
    expect(stopEvents()).toEqual([])
  })
})

describe('a Stop that writes no Stop event saves its target first', () => {
  const TASK: AgentChildWorkView = {
    id: 'child-task-1',
    providerId: 'task-1',
    kind: 'agent',
    state: 'working',
    membership: 'live',
    firstObservedAt: 1,
    observedAt: 1,
    stoppable: true,
    invocation: { invocationId: 'spawn-task-1', generation: 1 }
  }

  it('records the background tasks it reaches before it asks the provider', async () => {
    rig.host.deps.statusSink = { publish: () => {}, forget: () => {}, readChildWork: () => [TASK] }
    // The session's status row lands with the work, so its child records are read from it.
    await rig.workingSend()
    const stopBackgroundTasks = vi.fn(async () => ({ cancelled: true }))
    Object.assign(rig.host.deps.adapter, { stopBackgroundTasks })
    const id = opId()
    const fields = { turnId: 'background-tasks', scope: 'background-tasks' }
    let atStop: ReturnType<typeof receipt> | undefined
    stopBackgroundTasks.mockImplementationOnce(async () => {
      atStop = receipt(id)
      return { cancelled: true }
    })
    const stop = () =>
      rig.host.cancel(CALLER, {
        envelope: rig.envelope(fields, 'agentSession.cancel', id),
        turnId: 'background-tasks',
        scope: 'background-tasks' as const
      })

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(atStop).toMatchObject({
      verdict: 'readable',
      receipt: { result: { kind: 'stop' } }
    })
    expect(stopEvents()).toEqual([])
    expect(await stop()).toMatchObject({ ok: true, replayed: true })
    expect(stopBackgroundTasks).toHaveBeenCalledOnce()
  })

  it("records a prompt card's own Cancel before it interrupts", async () => {
    await rig.workingSend()
    await turnRow('turn-1', 'running')
    const prompt = await journal().appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 901 },
      {
        kind: 'approval',
        title: 'Run the command?',
        detail: null,
        options: [{ id: 'allow', label: 'Allow' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    const id = opId()
    const fields = {
      turnId: 'turn-1',
      prompt: { itemId: prompt.itemId, expectedRevision: prompt.revision }
    }
    let atInterrupt: ReturnType<typeof receipt> | undefined
    rig.cancelTurn.mockImplementationOnce(async () => {
      atInterrupt = receipt(id)
      return { cancelled: true }
    })

    expect(
      await rig.host.cancel(CALLER, {
        envelope: rig.envelope(fields, 'agentSession.cancel', id),
        ...fields
      })
    ).toMatchObject({ ok: true })
    expect(atInterrupt).toMatchObject({
      verdict: 'readable',
      receipt: { result: { kind: 'stop' } }
    })
    expect(rig.cancelTurn).toHaveBeenCalledOnce()
  })
})
