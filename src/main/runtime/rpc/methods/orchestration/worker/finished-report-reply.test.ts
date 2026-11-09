import { afterEach, describe, expect, it } from 'vitest'
import { getWorkerTerminalAutoReleaseScheduler } from '../../../../orchestration/terminal-authority/release/worker-terminal-auto-release-scheduler'
import { getFollowUpDispatch } from '../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import './worker-resume-session-capture'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

// A coordinator replying to a finished worker's report, through the same calls the CLI makes.
describe('a reply to a finished worker report', () => {
  const h = createOrchestrationWorkerReleaseHarness()

  afterEach(() => {
    getWorkerTerminalAutoReleaseScheduler(h.runtime).clear()
    h.cleanup()
  })

  async function reportDone() {
    const { taskId, dispatchId } = await h.startWorker()
    await h.call('orchestration.send', {
      from: 'term_worker',
      type: 'worker_done',
      subject: 'Done',
      payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
    })
    const report = h.db
      .getUnreadMessages(`run:${h.activeRunId}`)
      .find((message) => message.type === 'worker_done')!
    return { dispatchId, reportId: report.id }
  }

  const reply = (id: string) =>
    h.call('orchestration.reply', { id, from: 'term_coord', body: 'Also fix the docs' })

  it('is refused without writing anything, and check offers the send that continues the worker', async () => {
    h.setup()
    const { dispatchId, reportId } = await reportDone()

    await expect(reply(reportId)).rejects.toMatchObject({
      code: 'dispatch_inactive',
      data: { effectsApplied: false, followUp: { kind: 'send', dispatchId, active: false } }
    })
    expect(h.db.getMessageById(reportId)?.read).toBe(0)
    expect(h.db.getAllMessagesForHandle('term_worker')).toHaveLength(0)
    expect(h.db.getAllMessagesForHandle(`dispatch:${dispatchId}`)).toHaveLength(0)

    expect(await h.call('orchestration.check', { terminal: 'term_coord' })).toMatchObject({
      messages: [{ id: reportId, follow_up: { kind: 'send', dispatchId, active: false } }]
    })
  })

  it('never lands in a later task on the same terminal, and names that running follow-up', async () => {
    h.setup()
    const { dispatchId, reportId } = await reportDone()
    await h.call('orchestration.send', {
      from: 'term_coord',
      to: `dispatch:${dispatchId}`,
      subject: 'Next task',
      body: 'unrelated work'
    })
    const followUp = getFollowUpDispatch(h.db, dispatchId)!
    expect(followUp.status).toBe('dispatched')
    const before = h.db.getAllMessagesForHandle(`dispatch:${followUp.id}`).length

    await expect(reply(reportId)).rejects.toMatchObject({
      code: 'dispatch_inactive',
      data: { followUp: { kind: 'send', dispatchId: followUp.id, active: true } }
    })
    expect(h.db.getAllMessagesForHandle(`dispatch:${followUp.id}`)).toHaveLength(before)
    expect(h.db.getAllMessagesForHandle('term_worker')).toHaveLength(0)
  })

  it('refuses another message type to a finished worker by naming the continuing send, not a Run', async () => {
    h.setup()
    const { dispatchId } = await reportDone()

    const refused: unknown = await h
      .call('orchestration.send', {
        from: 'term_coord',
        to: `dispatch:${dispatchId}`,
        type: 'escalation',
        subject: 'Look again'
      })
      .catch((error: unknown) => error)

    expect(refused).toMatchObject({
      code: 'dispatch_inactive',
      message: expect.not.stringContaining(`run:${h.activeRunId}`),
      data: { followUp: { kind: 'send', dispatchId, active: false } }
    })
  })
})
