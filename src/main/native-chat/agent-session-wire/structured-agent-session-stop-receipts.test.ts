import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type { JournalStopEvent } from '../agent-session-journal/journal-row-schema'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { JournalStopAcceptor } from '../agent-session-journal/journal-stop-acceptance'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

const CALLER_SCOPE = { kind: 'caller', callerKey: CALLER.callerKey } as const

let rig: QueuedMessageTestRig
let serial = 0
let warned: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
  warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  rig.dispose()
})

function opId(): string {
  serial += 1
  return `${NOW}-${serial.toString(16).padStart(32, 'f')}`
}

function journal(): AgentSessionJournal {
  const open = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!open) {
    throw new Error('expected the conversation open')
  }
  return open
}

function receipt(id: string) {
  return rig.store.readCommandReceipt(CALLER_SCOPE, id)
}

it('does not treat completed submission history as a send in an empty reinitialization', async () => {
  const id = await rig.workingSend()
  await rig.settleAccepted(id, 'old')
  await turnRow('turn-old', 'interrupted')
  const child = rig.host.collaboratorsForTests().sessions.get(SESSION)!.child!
  child.phase = 'starting'
  expect(await rig.stop()).toMatchObject({ ok: true })
  expect(
    (await rig.host.journalSnapshot(SESSION)).items.filter((item) => item.body.kind === 'status')
  ).toEqual([])
})

function stopEvents(): { sequence: number; event: JournalStopEvent }[] {
  const since = journal().readSince({ epoch: journal().epoch, sequence: 0 })
  if (!since.ok) {
    throw new Error(`expected rows, got reset ${since.reset}`)
  }
  return since.rows.flatMap((row) =>
    row.kind === 'tombstone' && row.stopEvent ? [{ sequence: row.seq, event: row.stopEvent }] : []
  )
}

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
    {
      fence: rig.store.getRecord(SESSION)!.lease.runtimeFence,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  )
}

async function queuedSend(text: string): Promise<string> {
  const { id, result } = rig.send(text)
  await result
  const accepted = await rig.submission(id)
  expect(accepted && isQueuedAgentJournalSubmission(accepted)).toBe(true)
  return id
}

it('is saved before it interrupts, and a retry of its id never stops the newer turn', async () => {
  const working = await rig.workingSend()
  await turnRow('turn-1', 'running')
  const id = opId()
  let atInterrupt: ReturnType<typeof receipt> | undefined
  rig.cancelTurn.mockImplementationOnce(async () => {
    atInterrupt = receipt(id)
    return { cancelled: true }
  })
  expect(await rig.stop(id)).toMatchObject({
    ok: true,
    replayed: false,
    value: { cancelled: true }
  })
  const [mark] = stopEvents()
  expect(mark?.event).toMatchObject({ turnId: 'turn-1' })
  expect(receipt(id)).toMatchObject({
    verdict: 'readable',
    receipt: {
      method: 'agentSession.cancel',
      result: { kind: 'journal-row', epoch: journal().epoch, sequence: mark?.sequence }
    }
  })
  expect(atInterrupt).toEqual(receipt(id))
  await turnRow('turn-1', 'interrupted')
  await rig.settleAccepted(working, 'stopped')
  const newer = await rig.workingSend()
  await turnRow('turn-2', 'running')
  const behind = await queuedSend('queued behind the newer turn')

  expect(await rig.stop(id)).toMatchObject({
    ok: true,
    replayed: true,
    value: { cancelled: false }
  })

  expect(rig.cancelTurn).toHaveBeenCalledOnce()
  expect(stopEvents()).toHaveLength(1)
  expect(journal().runningTurn()?.turnId ?? null).toBe('turn-2')
  expect((await rig.submission(behind))?.dispatchState).not.toBe('rejected')
  expect((await rig.submission(newer))?.dispatchState).not.toBe('rejected')
  expect(await rig.drafts()).toEqual([])
  expect(await rig.stop()).toMatchObject({ ok: true, replayed: false, value: { cancelled: true } })
  expect(rig.cancelTurn).toHaveBeenCalledTimes(2)
})

it('answers a Stop naming a turn already over as a no-op, withdrawing nothing a newer turn queued', async () => {
  await rig.workingSend()
  await turnRow('turn-new', 'running')
  const behind = await queuedSend('queued behind the newer turn')
  const id = opId()

  expect(
    await rig.host.cancel(CALLER, {
      envelope: rig.envelope({ turnId: 'turn-gone' }, 'agentSession.cancel', id),
      turnId: 'turn-gone'
    })
  ).toMatchObject({ ok: true, replayed: false, value: { turnId: 'turn-gone', cancelled: false } })
  expect(receipt(id)).toMatchObject({
    verdict: 'readable',
    receipt: {
      result: { kind: 'no-op', outcome: { kind: 'cancel', cancelled: false, turnId: 'turn-gone' } }
    }
  })
  expect(rig.cancelTurn).not.toHaveBeenCalled()
  expect(stopEvents()).toEqual([])
  expect(await rig.submission(behind)).toMatchObject({ dispatchState: 'pending' })
  expect(await rig.drafts()).toEqual([])
})

it('refuses in plain words when it cannot be saved, interrupting and withdrawing nothing', async () => {
  await rig.workingSend()
  const queued = await queuedSend('queued behind the turn')
  const db = openTestJournalHostDatabase(rig.root).db
  db.exec(`CREATE TRIGGER fail_stop_receipt BEFORE INSERT ON agent_session_command_receipts
    BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END`)
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

it('interrupts and answers from its receipt when its write throws after the commit', async () => {
  await rig.workingSend()
  const id = opId()
  const accept = JournalStopAcceptor.prototype.accept
  vi.spyOn(JournalStopAcceptor.prototype, 'accept').mockImplementationOnce(async function (
    this: JournalStopAcceptor,
    ...args
  ) {
    await accept.apply(this, args)
    throw new Error('fold failed after commit')
  })

  expect(await rig.stop(id)).toMatchObject({ ok: true })
  expect(rig.cancelTurn).toHaveBeenCalledOnce()
  expect(receipt(id)).toMatchObject({ verdict: 'readable', receipt: { status: 'accepted' } })
  expect(warned.mock.calls.map((call) => String(call[0]))).toEqual(
    expect.arrayContaining([expect.stringContaining('a Stop was saved, then its write failed')])
  )
})

describe('a background-task Stop', () => {
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

  function failureNotes(): { text: string; failure?: unknown }[] {
    return journal()
      .snapshot()
      .items.flatMap((item) =>
        item.body.kind === 'status' && item.body.failure
          ? [{ text: item.body.text, failure: item.body.failure }]
          : []
      )
  }

  async function backgroundStopWith(
    stopBackgroundTasks: NonNullable<StructuredAgentSessionAdapter['stopBackgroundTasks']>,
    taskId?: string
  ) {
    rig.host.deps.statusSink = { publish: () => {}, forget: () => {}, readChildWork: () => [TASK] }
    await rig.workingSend()
    const id = opId()
    let atStop: ReturnType<typeof receipt> | undefined
    const provider = vi.fn(async (input: Parameters<typeof stopBackgroundTasks>[0]) => {
      atStop = receipt(id)
      return stopBackgroundTasks(input)
    })
    Object.assign(rig.host.deps.adapter, { stopBackgroundTasks: provider })
    const fields = {
      turnId: 'background-tasks',
      scope: 'background-tasks',
      ...(taskId ? { taskId } : {})
    }
    const stop = () =>
      rig.host.cancel(CALLER, {
        envelope: rig.envelope(fields, 'agentSession.cancel', id),
        turnId: 'background-tasks',
        scope: 'background-tasks' as const,
        ...(taskId ? { taskId } : {})
      })
    return { provider, stop, atStop: () => atStop }
  }

  it.each([
    [
      'one named task still runs',
      async () => ({ cancelled: false, stillRunning: true as const }),
      'task-1',
      {
        text: "The background task wasn't stopped.",
        failure: agentSessionFailureFact('backgroundTaskNotStopped', { backgroundStop: 'task' })
      }
    ],
    [
      'every task still runs',
      async () => ({ cancelled: false, stillRunning: true as const }),
      undefined,
      {
        text: "The background tasks weren't stopped.",
        failure: agentSessionFailureFact('backgroundTaskNotStopped', { backgroundStop: 'all' })
      }
    ],
    [
      'the agent timed out',
      async () => {
        throw new Error('codex app-server request timed out')
      },
      undefined,
      { text: 'Cancellation was not confirmed.', failure: { kind: 'cancelUnconfirmed' } }
    ]
  ])(
    'notes that %s; a retry neither asks again nor notes again',
    async (_, answer, taskId, note) => {
      const { provider, stop, atStop } = await backgroundStopWith(answer, taskId)

      expect(await stop()).toMatchObject({
        ok: true,
        value: { turnId: 'background-tasks', cancelled: false }
      })
      expect(atStop()).toMatchObject({ verdict: 'readable', receipt: { result: { kind: 'stop' } } })
      expect(failureNotes()).toEqual([note])

      expect(await stop()).toMatchObject({
        ok: true,
        replayed: true,
        value: { turnId: 'background-tasks', cancelled: false }
      })
      expect(provider).toHaveBeenCalledOnce()
      expect(failureNotes()).toHaveLength(1)
    }
  )
})
