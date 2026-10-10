// Background bookkeeping meeting another connection's write lock: it fails at once and ends the
// retry's round (no 5 s wait on the main thread), while a person's write in the same tick still
// waits the lock out. One episode's give-up is never a latch: a commit or a signal re-arms it, and
// a queued send given up on reads as not sent even when its stored hold cannot be written.

import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../shared/agent-session-wire'
import { journalDatabasePath } from '../agent-session-journal/journal-host-database'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { JournalQueuedMessages } from '../agent-session-journal/journal-queued-messages'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { isSqliteContentionFailure } from '../../sqlite/sqlite-read-failure'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import {
  currentJournal,
  exitWhileSettlementFails,
  leaveUnfinishedWork,
  turnState
} from './structured-agent-session-leftover-settlement.test-fixture'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig | undefined
let locker: Worker | undefined

afterEach(async () => {
  vi.useRealTimers()
  await locker?.terminate()
  locker = undefined
  await rig?.dispose()
  rig = undefined
  vi.restoreAllMocks()
})

/** Another connection, on its own thread, holds the write lock for `ms`: this thread's waits
 *  cannot release it, as another process's could not. Resolves once the lock is held. */
function holdWriteLock(stateDirectory: string, ms: number): Promise<{ released: Promise<void> }> {
  const worker = new Worker(
    `const { workerData, parentPort } = require('node:worker_threads')
     const { DatabaseSync } = require('node:sqlite')
     const db = new DatabaseSync(workerData.file)
     db.exec('BEGIN IMMEDIATE')
     parentPort.postMessage('locked')
     setTimeout(() => { db.exec('ROLLBACK'); db.close(); parentPort.postMessage('released') }, workerData.ms)`,
    { eval: true, workerData: { file: journalDatabasePath(stateDirectory), ms } }
  )
  locker = worker
  let release: () => void = () => undefined
  const released = new Promise<void>((resolve) => (release = resolve))
  return new Promise((resolve) =>
    worker.on('message', (message) => (message === 'locked' ? resolve({ released }) : release()))
  )
}

/** The longest the main thread went without running a timer, while `run` ran. */
async function longestStall(run: () => Promise<unknown>): Promise<number> {
  let last = performance.now()
  let longest = 0
  const probe = setInterval(() => {
    const now = performance.now()
    longest = Math.max(longest, now - last)
    last = now
  }, 2)
  try {
    await run()
    return Math.max(longest, performance.now() - last)
  } finally {
    clearInterval(probe)
  }
}

const locked = () => Object.assign(new Error('database is locked'), { errcode: 5 })

/** A chat whose exit left its settlement owed to the retry, with nothing refusing it now. */
async function settlementOwed(): Promise<QueuedMessageTestRig> {
  rig = await createQueuedMessageTestRig({ restartable: true })
  await rig.workingSend()
  await leaveUnfinishedWork(rig, { prompt: true })
  const { database } = await exitWhileSettlementFails(rig)
  database.db.exec('DROP TRIGGER reject_recovered')
  return rig
}

describe("another connection's write lock", () => {
  it('ends a background round at once, never stalling the main thread, and a send then waits only for the lock', async () => {
    const current = await settlementOwed()
    const { reconciliation } = current.host.collaboratorsForTests()
    const { released } = await holdWriteLock(current.root, 1_500)

    const started = performance.now()
    const stall = await longestStall(async () => {
      reconciliation.signal(SESSION)
      await reconciliation.attempted(SESSION)
    })
    expect(performance.now() - started).toBeLessThan(150)
    expect(stall).toBeLessThan(60)
    expect(reconciliation.owes(SESSION)).toBe(true)
    expect(turnState(current)).toBe('running')

    // A person's send waits the lock out (its own 5 s budget), never behind background work.
    const sent = performance.now()
    const { result } = current.send('go on')
    expect(await result).toMatchObject({ ok: true })
    await released
    expect(performance.now() - sent).toBeLessThan(2_000)
    // Its commit proves the connection free: a fresh episode lands the settlement at once.
    await eventually(() => expect(turnState(current)).toBe('interrupted'))
  })

  it('refuses a background transaction at once while a write in the same tick waits it out', async () => {
    rig = await createQueuedMessageTestRig({ restartable: true })
    const { store } = rig
    const database = openTestJournalHostDatabase(rig.root)
    const busyTimeout = database.db.pragma('busy_timeout', { simple: true })
    const touch =
      (by: number) => (record: Parameters<Parameters<typeof store.transitionHandoff>[1]>[0]) => ({
        ...record,
        lease: { ...record.lease, lastRenewedAt: record.lease.lastRenewedAt + by }
      })
    const { released } = await holdWriteLock(rig.root, 400)

    const started = performance.now()
    const background = store.transitionHandoff(SESSION, touch(1), { background: true })
    const user = store.transitionHandoff(SESSION, touch(2))

    // Refused, though the lock lifts long inside its 5 s: it never waited.
    await expect(background).rejects.toSatisfy(isSqliteContentionFailure)
    await expect(user).resolves.toMatchObject({ sessionId: SESSION })
    expect(performance.now() - started).toBeGreaterThan(300)
    await released
    expect(database.db.pragma('busy_timeout', { simple: true })).toBe(busyTimeout)
  })
})

describe("the pass's reopen mark", () => {
  it('is background: under a real lock it fails at once, ends the round, and lands once the lock lifts', async () => {
    rig = await createQueuedMessageTestRig()
    const current = rig
    await current.workingSend()
    await current.send('queued before the crash', 'queue-if-active').result
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const mark = AgentSessionJournal.prototype.markQueueReopen
    const tried: { options: unknown; failed: boolean; ms: number }[] = []
    vi.spyOn(AgentSessionJournal.prototype, 'markQueueReopen').mockImplementation(async function (
      this: AgentSessionJournal,
      ...args: Parameters<AgentSessionJournal['markQueueReopen']>
    ) {
      // The first mark meets another connection's lock, taken after the pass's earlier writes.
      if (tried.length === 0) {
        await holdWriteLock(current.root, 1_000)
      }
      const started = performance.now()
      try {
        await mark.apply(this, args)
        tried.push({ options: args[2], failed: false, ms: performance.now() - started })
      } catch (error) {
        const ms = performance.now() - started
        tried.push({ options: args[2], failed: isSqliteContentionFailure(error), ms })
        throw error
      }
    })
    await current.crashRestartHostProcess()

    await vi.waitFor(() => expect(tried.some((attempt) => !attempt.failed)).toBe(true), {
      timeout: 8_000
    })
    expect(tried[0]).toMatchObject({ options: { background: true }, failed: true })
    expect(tried[0]!.ms).toBeLessThan(150)
    expect(tried.at(-1)).toMatchObject({ options: { background: true }, failed: false })
  })
})

describe('an episode the retry gives up', () => {
  /** Lets every visit a fired timer began run to its end, with no fake time passing. */
  async function settleTurns(): Promise<void> {
    for (let turn = 0; turn < 50; turn++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  async function exhaust(current: QueuedMessageTestRig): Promise<ReturnType<typeof vi.spyOn>> {
    const attempts = vi
      .spyOn(currentJournal(current), 'appendPlannedLifecycleBatch')
      .mockRejectedValue(locked())
    for (let round = 0; round < 12; round += 1) {
      await vi.advanceTimersByTimeAsync(31_000)
      await settleTurns()
    }
    const given = attempts.mock.calls.length
    await vi.advanceTimersByTimeAsync(120_000)
    await settleTurns()
    // Ten rounds, then no timer: the set is kept, and nothing retries on its own.
    expect(attempts.mock.calls.length).toBe(given)
    expect(current.host.collaboratorsForTests().reconciliation.owes(SESSION)).toBe(true)
    attempts.mockRestore()
    return attempts
  }

  it.each(['a commit on the connection', 'a new signal'])(
    'is re-armed by %s, and the work lands',
    async (trigger) => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const current = await settlementOwed()
      await exhaust(current)
      expect(turnState(current)).toBe('running')

      const { reconciliation } = current.host.collaboratorsForTests()
      if (trigger === 'a new signal') {
        reconciliation.signal(SESSION)
      } else {
        await currentJournal(current).appendQueueResume(
          current.store.getRecord(SESSION)!.lease.runtimeFence
        )
      }
      await settleTurns()

      expect(turnState(current)).toBe('interrupted')
      expect(reconciliation.owes(SESSION)).toBe(false)
    }
  )
})

describe('a queued send the retry gives up on', () => {
  it('reads as not sent from memory when its stored hold cannot be written either', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    const working = await current.workingSend()
    const queued = await current.send('after this', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    vi.spyOn(AgentSessionJournal.prototype, 'appendSubmission').mockRejectedValue(locked())
    const hold = vi.spyOn(JournalQueuedMessages.prototype, 'hold').mockRejectedValue(locked())

    await current.settleAccepted(working, 'a')
    for (let round = 0; round < 12; round += 1) {
      await vi.advanceTimersByTimeAsync(31_000)
    }

    expect(hold).toHaveBeenCalledTimes(1)
    const page = await current.host.history({ sessionId: SESSION, direction: 'tail' })
    expect(page.ok && page.page.queuedMessages).toEqual([
      expect.objectContaining({
        messageId: queued.value.queued.messageId,
        paused: true,
        pausedReason: QUEUED_MESSAGE_PAUSED_SEND_FAILED
      })
    ])
    expect(page.ok && page.page.nextQueuedMessageId).toBeNull()
  })

  it('holds the card with "Couldn\'t send" at once for a refusal', async () => {
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    const working = await current.workingSend()
    await current.send('after this', 'queue-if-active').result
    vi.spyOn(AgentSessionJournal.prototype, 'appendSubmission').mockRejectedValueOnce(
      new Error('disk full')
    )

    await current.settleAccepted(working, 'a')
    await eventually(async () => {
      const page = await current.host.history({ sessionId: SESSION, direction: 'tail' })
      expect(page.ok && page.page.queuedMessages?.[0]?.pausedReason).toBe(
        QUEUED_MESSAGE_PAUSED_SEND_FAILED
      )
    })
  })
})
