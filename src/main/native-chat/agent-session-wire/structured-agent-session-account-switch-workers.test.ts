import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { acquiredAgentSessionAccount } from '../../../shared/agent-session-acquired-account'
import { describe, expect, it, vi } from 'vitest'
import { dispatchReportMailbox } from '../../runtime/orchestration/dispatch-report-mailbox'
import { OrchestrationStructuredMailboxPointerDelivery } from '../../runtime/orchestration/structured-mailbox-pointer-delivery'
import { createStructuredMailboxPointerHost } from '../../runtime/orchestration/structured-mailbox-pointer-host'
import { HOST_TEST_NOW } from './structured-agent-session-host-test-data'
import {
  createReceivingCallerFixture,
  PARENT,
  WORKER
} from './structured-agent-session-receiving-callers.test-support'

type Fixture = Awaited<ReturnType<typeof createReceivingCallerFixture>>
type Worker = Awaited<ReturnType<Fixture['createWorker']>>

function journal(f: Fixture) {
  return f.rig.host.collaboratorsForTests().sessions.get(PARENT)?.journal
}

function settledState(f: Fixture, id: string) {
  const submission = journal(f)?.submission(id)
  return submission?.dispatchState === 'pending' ? undefined : submission
}

/** Production report transaction -> pointer wake -> host start/handover, as a coordinator receives a result. */
async function reportResult(f: Fixture, worker: Worker) {
  const db = f.runtime.getOrchestrationDb()
  const mailbox = dispatchReportMailbox(db, worker.dispatch)
  await f.report(worker)
  expect(f.nudges).toHaveBeenCalledWith(mailbox, 'worker_done')
  const pointer = new OrchestrationStructuredMailboxPointerDelivery({
    getDb: () => db,
    getMessageWaiters: () => undefined,
    resolveStructuredTarget: (handle) => f.runtime.mailTarget(handle),
    getCliCommand: () => 'orca-dev',
    senderSnapshot: () => ({ name: null, agent: null }),
    host: createStructuredMailboxPointerHost()
  })
  const unsubscribe = await f.rig.host.subscribe({
    id: 'result-pointer-wake',
    sessionId: PARENT,
    emit: () => pointer.onJournalActivity(PARENT)
  })
  expect(pointer.deliverForHandle(mailbox)).toBe(true)
  const notices = () => {
    const current = journal(f)
    return (current?.submissions() ?? []).filter((submission) => {
      const body = current?.itemBody(agentJournalSubmissionKey(submission.clientMessageId))
      return body?.kind === 'message' && body.from?.orchestration?.message === 'mail-notice'
    })
  }
  return {
    unsubscribe,
    notices,
    /** The worker's result mail, while the coordinator has not been handed it. */
    undelivered: () =>
      db.getUnreadMessages(mailbox, ['worker_done']).filter((row) => row.delivered_at === null),
    settled: async () => {
      let settled: ReturnType<typeof notices>[number] | undefined
      await vi.waitFor(() => {
        settled = notices().find((notice) => notice.dispatchState !== 'pending')
        expect(settled).toBeDefined()
      })
      return settled
    }
  }
}

async function coordinatorWithWorker(f: Fixture) {
  await f.found()
  expect(f.rig.host.childAccountHome(PARENT)).toEqual(f.homeA)
  f.runtime.getOrchestrationDb().createRun({
    objective: 'coordinate a worker',
    coordinatorHandle: null,
    coordinatorPaneKey: null,
    coordinatorOrcaSessionId: PARENT
  })
  return f.createWorker(WORKER)
}

describe('a coordinator chat whose worker is still running when the account is switched', () => {
  it('answers the worker result on the new account when it arrives first, and keeps that agent for the next message', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(HOST_TEST_NOW)
    const f = await createReceivingCallerFixture()
    try {
      const worker = await coordinatorWithWorker(f)
      f.selectB()
      f.rig.adapter.acquire.mockClear()

      // Nothing has replaced the agent on A when the result arrives.
      const result = await reportResult(f, worker)
      try {
        expect((await result.settled())?.dispatchState).toBe('accepted')
      } finally {
        result.unsubscribe()
      }
      expect(f.rig.adapter.closeSession).toHaveBeenCalledWith(PARENT, undefined)
      expect(f.rig.host.childAccountHome(PARENT)).toEqual(f.homeB)
      expect(f.launches.at(-1)).toBe(f.homeB.path)
      expect(f.rig.adapter.acquire).toHaveBeenCalledTimes(1)
      expect(result.undelivered()).toEqual([])

      await f.send('keep going')
      expect(f.rig.host.childAccountHome(PARENT)).toEqual(f.homeB)
      expect(f.rig.adapter.acquire).toHaveBeenCalledTimes(1)
    } finally {
      await f.dispose()
    }
  })

  it('answers a result that arrives after its process ended on the new account, not the one it last ran on', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(HOST_TEST_NOW)
    const f = await createReceivingCallerFixture()
    try {
      const worker = await coordinatorWithWorker(f)
      // A cold start reads only saved state, as it does after a restart.
      await f.rig.host.close(PARENT, 'evict')
      expect(
        acquiredAgentSessionAccount(f.rig.store.requireWritableRecord(PARENT))?.recipe
      ).toMatchObject({ route: 'managed', accountId: 'a', home: f.homeA.path })
      f.selectB()
      f.rig.adapter.acquire.mockClear()

      const result = await reportResult(f, worker)
      try {
        expect((await result.settled())?.dispatchState).toBe('accepted')
      } finally {
        result.unsubscribe()
      }
      expect(f.launches.at(-1)).toBe(f.homeB.path)
      expect(f.rig.host.childAccountHome(PARENT)).toEqual(f.homeB)
      expect(f.rig.adapter.acquire).toHaveBeenCalledTimes(1)
      expect(
        acquiredAgentSessionAccount(f.rig.store.requireWritableRecord(PARENT))?.recipe
      ).toMatchObject({ route: 'managed', accountId: 'b', home: f.homeB.path })
    } finally {
      await f.dispose()
    }
  })
})

describe('a worker result launches a resting coordinator exactly as a message from the user does', () => {
  const cases: {
    name: string
    arrange: (f: Fixture) => void
    /** The folder the Claude process starts under; none when launch refuses first. */
    home: (f: Fixture) => string | undefined
    outcome: { dispatchState: 'accepted' } | { dispatchState: 'rejected'; rejection: string }
    /** Brings back a refused result: a later message from the user that runs. */
    recover?: (f: Fixture) => void
  }[] = [
    {
      name: 'the account it ran on was removed',
      arrange: (f) => {
        f.selectB()
        f.removeAccount('a')
        rmSync(dirname(f.homeA.path), { recursive: true, force: true })
      },
      home: (f) => f.homeB.path,
      outcome: { dispatchState: 'accepted' }
    },
    {
      name: 'the selected account is signed out',
      arrange: (f) => {
        f.selectB()
        f.signedOut.add(f.homeB.path)
      },
      home: (f) => f.homeB.path,
      outcome: { dispatchState: 'rejected', rejection: 'notSignedIn' }
    },
    {
      name: 'its history is only under the account it ran on',
      arrange: (f) => {
        f.selectB()
        f.transcripts.add(f.homeA.path)
      },
      // Under A it would resume; the refusal is what launching under B finds.
      home: () => undefined,
      outcome: { dispatchState: 'rejected', rejection: 'historyInOtherAccount' },
      recover: (f) => f.select('a')
    },
    {
      name: 'System default is selected',
      arrange: (f) => f.select(null),
      home: (f) => f.systemHome.path,
      outcome: { dispatchState: 'accepted' }
    }
  ]

  it.each(cases)('$name', async ({ arrange, home, outcome, recover }) => {
    let clock = HOST_TEST_NOW
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const outcomes: unknown[] = []
    for (const path of ['user message', 'worker result'] as const) {
      const f = await createReceivingCallerFixture()
      try {
        const worker = await coordinatorWithWorker(f)
        await f.rig.host.close(PARENT, 'evict')
        arrange(f)
        f.launches.length = 0

        if (path === 'user message') {
          const id = await f.accept('continue')
          await vi.waitFor(() => expect(settledState(f, id)).toBeDefined())
          expect(f.launches.at(-1)).toBe(home(f))
          expect(existsSync(f.homeA.path)).toBe(f.accounts().includes('a'))
          outcomes.push(settledState(f, id))
          continue
        }
        const result = await reportResult(f, worker)
        try {
          outcomes.push(await result.settled())
          expect(f.launches.at(-1)).toBe(home(f))
          expect(existsSync(f.homeA.path)).toBe(f.accounts().includes('a'))
          if (outcome.dispatchState === 'accepted') {
            expect(result.undelivered()).toEqual([])
            continue
          }
          // A refused result is never marked handed over; it stays owed to the coordinator.
          expect(result.undelivered()).toHaveLength(1)
          if (recover) {
            recover(f)
            expect(result.undelivered()).toHaveLength(1)
            // The user's message comes after the refused result.
            f.rig.clock.now += 1_000
            clock += 1_000
            await f.turn(await f.send('back on a'), 'completed')
            await vi.waitFor(() =>
              expect(result.notices().filter((n) => n.dispatchState === 'accepted')).toHaveLength(1)
            )
            await vi.waitFor(() => expect(result.undelivered()).toEqual([]))
            expect(f.rig.host.childAccountHome(PARENT)).toEqual(f.homeA)
          }
        } finally {
          result.unsubscribe()
        }
      } finally {
        await f.dispose()
      }
    }
    const expected = {
      dispatchState: outcome.dispatchState,
      ...(outcome.dispatchState === 'rejected'
        ? { rejection: expect.objectContaining({ kind: outcome.rejection }) }
        : {})
    }
    expect(outcomes).toEqual([expect.objectContaining(expected), expect.objectContaining(expected)])
  })
})
