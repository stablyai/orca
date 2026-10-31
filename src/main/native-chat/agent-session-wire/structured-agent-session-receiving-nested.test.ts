import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { describe, expect, it, vi } from 'vitest'
import { dispatchReportMailbox } from '../../runtime/orchestration/dispatch-report-mailbox'
import { OrchestrationStructuredMailboxPointerDelivery } from '../../runtime/orchestration/structured-mailbox-pointer-delivery'
import { createStructuredMailboxPointerHost } from '../../runtime/orchestration/structured-mailbox-pointer-host'
import { HOST_TEST_NOW } from './structured-agent-session-host-test-data'
import {
  createReceivingCallerFixture,
  HELPER,
  HOME_A,
  HOME_B,
  PARENT,
  WORKER
} from './structured-agent-session-receiving-callers.test-support'

/** Production report transaction -> pointer park/wake -> host start/handover/settlement. */
describe('nested receiving work follows its current consumer', () => {
  it('keeps A after creator Stop, accepts its helper result, then ordinary input acquires B', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(HOST_TEST_NOW)
    const f = await createReceivingCallerFixture()
    let unsubscribe: (() => void) | undefined
    try {
      await f.found()
      const db = f.runtime.getOrchestrationDb()
      const run = db.createRun({
        objective: 'nested production iteration',
        coordinatorHandle: null,
        coordinatorPaneKey: null,
        coordinatorOrcaSessionId: PARENT
      })
      const worker = await f.createWorker(WORKER)
      const helper = await f.createWorker(HELPER, WORKER)
      expect(helper.task.id).not.toBe(worker.task.id)
      expect(dispatchReportMailbox(db, helper.dispatch)).toBe(`dispatch:${worker.dispatch.id}`)
      const stopped = await f.call('orchestration.workerStop', { dispatch: worker.dispatch.id })
      expect(stopped).toMatchObject({ state: 'stopped', processAction: 'closed_agent_terminal' })
      expect(db.getDispatchContextById(helper.dispatch.id)?.status).toBe('dispatched')
      expect(dispatchReportMailbox(db, helper.dispatch)).toBe(`run:${run.id}`)
      await f.rig.host.close(PARENT, 'evict')
      f.selectB()
      f.rig.adapter.acquire.mockClear()
      const ordinary = await f.send('continue while the helper works')
      await f.turn(ordinary, 'running')
      expect(f.rig.host.childAccountHome(PARENT)).toEqual(HOME_A)
      expect(f.rig.adapter.acquire.mock.calls[0]?.[0].accountRecipe?.home).toBe(HOME_A.path)

      const nudges = f.nudges
      await f.call(
        'orchestration.send',
        {
          from: helper.handle,
          to: `run:${run.id}`,
          type: 'status',
          subject: 'finishing helper work'
        },
        f.caller(HELPER)
      )
      const batch = db.getOrCreateMailboxDelivery({
        runId: run.id,
        mailboxHandle: `run:${run.id}`,
        consumerGeneration: run.consumer_generation
      })
      if (!batch) {
        throw new Error('real status not accepted into the current Run')
      }
      expect(batch.messages.map((message) => message.to_handle)).toEqual([`run:${run.id}`])
      expect(batch.messages.map((message) => message.type)).toEqual(['status'])
      await f.report(helper)
      expect(nudges).toHaveBeenCalledWith(`run:${run.id}`, 'worker_done')
      expect(db.getWorkerDispatch(helper.dispatch.id)?.state).toBe('succeeded')
      const retained = vi.fn()
      const pointer = new OrchestrationStructuredMailboxPointerDelivery({
        getDb: () => db,
        getMessageWaiters: () => undefined,
        resolveStructuredTarget: (handle) => f.runtime.mailTarget(handle),
        getCliCommand: () => 'orca-dev',
        senderName: () => null,
        host: createStructuredMailboxPointerHost(),
        onRetain: retained
      })
      unsubscribe = await f.rig.host.subscribe({
        id: 'real-pointer-wake',
        sessionId: PARENT,
        emit: () => pointer.onJournalActivity(PARENT)
      })
      const dispatches = f.rig.adapter.dispatch.mock.calls.length
      expect(pointer.deliverForHandle(`run:${run.id}`)).toBe(true)
      await vi.waitFor(() =>
        expect(retained).toHaveBeenCalledWith(expect.objectContaining({ reason: 'turn-unsettled' }))
      )
      expect(f.rig.adapter.dispatch).toHaveBeenCalledTimes(dispatches)
      await f.turn(ordinary, 'completed')
      await vi.waitFor(() => expect(f.rig.adapter.dispatch.mock.calls.length).toBe(dispatches + 1))
      const journal = f.rig.host.collaboratorsForTests().sessions.get(PARENT)?.journal
      if (!journal) {
        throw new Error('actual opened parent journal missing')
      }
      const notice = journal.submissions().find((submission) => {
        const body = journal.itemBody(agentJournalSubmissionKey(submission.clientMessageId))
        return body?.kind === 'message' && body.from?.orchestration?.message === 'mail-notice'
      })
      if (!notice) {
        throw new Error('production pointer did not submit its canonical notice')
      }
      await f.turn(notice.clientMessageId, 'running')
      db.acknowledgeMailboxDelivery({
        runId: run.id,
        mailboxHandle: `run:${run.id}`,
        consumerGeneration: run.consumer_generation,
        deliveryId: batch.delivery.id
      })
      const resultBatch = db.getOrCreateMailboxDelivery({
        runId: run.id,
        mailboxHandle: `run:${run.id}`,
        consumerGeneration: run.consumer_generation
      })
      if (!resultBatch) {
        throw new Error('real report not accepted into the current Run')
      }
      expect(resultBatch.messages.map((message) => message.to_handle)).toEqual([`run:${run.id}`])
      expect(resultBatch.messages.map((message) => message.type)).toEqual(['worker_done'])
      db.acknowledgeMailboxDelivery({
        runId: run.id,
        mailboxHandle: `run:${run.id}`,
        consumerGeneration: run.consumer_generation,
        deliveryId: resultBatch.delivery.id
      })
      expect(await f.rig.host.prospectiveAccountHome(PARENT)).toEqual(HOME_A)
      await f.turn('unrelated-newer', 'completed')
      expect(await f.rig.host.prospectiveAccountHome(PARENT)).toEqual(HOME_A)
      await f.turn(notice.clientMessageId, 'completed')
      expect(await f.rig.host.prospectiveAccountHome(PARENT)).toEqual(HOME_B)
      const next = await f.send('next eligible ordinary input')
      expect(f.rig.host.childAccountHome(PARENT)).toEqual(HOME_B)
      expect(f.rig.adapter.acquire).toHaveBeenCalledTimes(2)
      await f.turn(next, 'completed')
    } finally {
      unsubscribe?.()
      await f.dispose()
    }
  })
})
