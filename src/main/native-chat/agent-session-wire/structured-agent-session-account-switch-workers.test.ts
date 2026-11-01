import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { acquiredAgentSessionAccount } from '../../../shared/agent-session-acquired-account'
import { describe, expect, it, vi } from 'vitest'
import { dispatchReportMailbox } from '../../runtime/orchestration/dispatch-report-mailbox'
import { OrchestrationStructuredMailboxPointerDelivery } from '../../runtime/orchestration/structured-mailbox-pointer-delivery'
import { createStructuredMailboxPointerHost } from '../../runtime/orchestration/structured-mailbox-pointer-host'
import { HOST_TEST_NOW } from './structured-agent-session-host-test-data'
import {
  createReceivingCallerFixture,
  HOME_A,
  HOME_B,
  PARENT,
  WORKER
} from './structured-agent-session-receiving-callers.test-support'

type Fixture = Awaited<ReturnType<typeof createReceivingCallerFixture>>

/** Production report transaction -> pointer wake -> host start/handover, as a coordinator receives a result. */
async function deliverResult(f: Fixture, worker: Awaited<ReturnType<Fixture['createWorker']>>) {
  const db = f.runtime.getOrchestrationDb()
  const mailbox = dispatchReportMailbox(db, worker.dispatch)
  await f.report(worker)
  expect(f.nudges).toHaveBeenCalledWith(mailbox, 'worker_done')
  const pointer = new OrchestrationStructuredMailboxPointerDelivery({
    getDb: () => db,
    getMessageWaiters: () => undefined,
    resolveStructuredTarget: (handle) => f.runtime.mailTarget(handle),
    getCliCommand: () => 'orca-dev',
    senderName: () => null,
    host: createStructuredMailboxPointerHost()
  })
  const unsubscribe = await f.rig.host.subscribe({
    id: 'result-pointer-wake',
    sessionId: PARENT,
    emit: () => pointer.onJournalActivity(PARENT)
  })
  try {
    expect(pointer.deliverForHandle(mailbox)).toBe(true)
    await vi.waitFor(() => {
      const journal = f.rig.host.collaboratorsForTests().sessions.get(PARENT)?.journal
      const notice = journal?.submissions().find((submission) => {
        const body = journal.itemBody(agentJournalSubmissionKey(submission.clientMessageId))
        return body?.kind === 'message' && body.from?.orchestration?.message === 'mail-notice'
      })
      expect(notice?.dispatchState).toBe('accepted')
    })
  } finally {
    unsubscribe()
  }
}

describe('a coordinator chat whose worker is still running when the account is switched', () => {
  it('sends its next message and the later worker result on the new account', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(HOST_TEST_NOW)
    const f = await createReceivingCallerFixture()
    try {
      await f.found()
      expect(f.rig.host.childAccountHome(PARENT)).toEqual(HOME_A)
      f.runtime.getOrchestrationDb().createRun({
        objective: 'coordinate a worker',
        coordinatorHandle: null,
        coordinatorPaneKey: null,
        coordinatorOrcaSessionId: PARENT
      })
      const worker = await f.createWorker(WORKER)
      f.selectB()
      f.rig.adapter.acquire.mockClear()

      const next = await f.send('keep going while the worker runs')
      expect(f.rig.host.childAccountHome(PARENT)).toEqual(HOME_B)
      expect(f.rig.adapter.acquire).toHaveBeenCalledTimes(1)
      expect(
        f.runtime.getOrchestrationDb().getDispatchContextById(worker.dispatch.id)?.status
      ).toBe('dispatched')
      await f.turn(next, 'completed')

      await deliverResult(f, worker)
      expect(f.rig.host.childAccountHome(PARENT)).toEqual(HOME_B)
      expect(f.rig.adapter.acquire).toHaveBeenCalledTimes(1)
    } finally {
      await f.dispose()
    }
  })

  it('answers a result that arrives after its process ended on the new account, not the one it last ran on', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(HOST_TEST_NOW)
    const f = await createReceivingCallerFixture()
    try {
      await f.found()
      f.runtime.getOrchestrationDb().createRun({
        objective: 'coordinate a worker',
        coordinatorHandle: null,
        coordinatorPaneKey: null,
        coordinatorOrcaSessionId: PARENT
      })
      const worker = await f.createWorker(WORKER)
      // A cold start reads only saved state, as it does after a restart.
      await f.rig.host.close(PARENT, 'evict')
      expect(
        acquiredAgentSessionAccount(f.rig.store.requireWritableRecord(PARENT))?.recipe.home
      ).toBe(HOME_A.path)
      f.selectB()
      f.rig.adapter.acquire.mockClear()

      await deliverResult(f, worker)
      expect(f.rig.host.childAccountHome(PARENT)).toEqual(HOME_B)
      expect(f.rig.adapter.acquire).toHaveBeenCalledTimes(1)
      expect(
        acquiredAgentSessionAccount(f.rig.store.requireWritableRecord(PARENT))?.recipe.home
      ).toBe(HOME_B.path)
    } finally {
      await f.dispose()
    }
  })
})
