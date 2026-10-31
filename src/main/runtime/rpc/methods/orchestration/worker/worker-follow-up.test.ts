import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getWorkerTerminalAutoReleaseScheduler } from '../../../../orchestration/worker-terminal-auto-release-scheduler'
import {
  getFollowUpDispatch,
  readWorkerResumeSession
} from '../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import { captureMovedWorkerResumeSessions } from './worker-resume-session-capture'
import { continueAllUnreadWorkerMail } from '../messaging/settled-worker-follow-through'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

// A send to a finished terminal worker, through the same worker-start the coordinator would run.
describe('a follow-up to a finished terminal worker', () => {
  const h = createOrchestrationWorkerReleaseHarness()
  let userDataDir: string | undefined

  afterEach(() => {
    getWorkerTerminalAutoReleaseScheduler(h.runtime).clear()
    h.cleanup()
    if (userDataDir) {
      rmSync(userDataDir, { recursive: true, force: true })
      userDataDir = undefined
    }
  })

  const send = (dispatchId: string, body: string) =>
    h.call('orchestration.send', {
      from: 'term_coord',
      to: `dispatch:${dispatchId}`,
      subject: 'More',
      body
    })

  it('starts no second worker while it cannot tell whether the first still runs', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    vi.spyOn(h.runtime, 'getTerminalLivenessVerdict').mockReturnValue({
      status: 'unverifiable',
      reason: 'relay_dropped'
    })

    await expect(send(dispatchId, 'and the docs')).rejects.toMatchObject({
      code: 'worker_unverifiable'
    })
    expect(getFollowUpDispatch(h.db, dispatchId)).toBeUndefined()
    expect(h.runtime.createTerminal).toHaveBeenCalledTimes(1)
  })

  it('continues the worker with mail it never read before reporting, after a restart', async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-follow-up-restart-'))
    h.setup({ userDataDir })
    const { taskId, dispatchId } = await h.startWorker()
    await send(dispatchId, 'and the docs')
    // The report settles; the app quits before anything continues that mail.
    h.settle(taskId, dispatchId, 'succeeded')
    expect(h.db.getDispatchContextById(dispatchId)?.follow_up_mail_at).not.toBeNull()

    h.restart()

    await vi.waitFor(() => expect(getFollowUpDispatch(h.db, dispatchId)).toBeDefined())
    const followUp = getFollowUpDispatch(h.db, dispatchId)!
    expect(h.db.getTask(followUp.task_id)?.spec).toContain('and the docs')
    await vi.waitFor(() =>
      expect(h.db.getDispatchContextById(dispatchId)?.follow_up_mail_at).toBeNull()
    )
    expect(h.db.getUnreadMessages(`dispatch:${dispatchId}`)).toHaveLength(0)
  })

  it('after a restart, moves unread mail to the follow-up that won and wakes it, once', async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-follow-up-moved-'))
    h.setup({ userDataDir })
    const { taskId, dispatchId } = await h.startWorker()
    await send(dispatchId, 'and the docs')
    h.settle(taskId, dispatchId, 'succeeded')
    const winner = h.db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 9,
      taskSpec: 'first',
      taskRunId: h.activeRunId,
      startOptions: { agent: 'codex' },
      followUpOf: dispatchId
    })

    h.restart()
    const arrived = vi.spyOn(h.runtime, 'notifyMessageArrived')

    await vi.waitFor(() =>
      expect(h.db.getDispatchContextById(dispatchId)?.follow_up_mail_at).toBeNull()
    )
    continueAllUnreadWorkerMail(h.runtime, h.db)
    expect(h.db.getUnreadMessages(`dispatch:${winner.dispatch.id}`)).toMatchObject([
      { body: 'and the docs' }
    ])
    expect(arrived.mock.calls).toEqual([[`dispatch:${winner.dispatch.id}`, 'status']])
    expect(getFollowUpDispatch(h.db, winner.dispatch.id)).toBeUndefined()
  })

  it('from a follow-up that never got a worker, continues the worker before it', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    const failed = h.db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 9,
      taskSpec: 'first',
      taskRunId: h.activeRunId,
      startOptions: { agent: 'codex' },
      followUpOf: dispatchId
    })
    h.db.failWorkerStart(failed.dispatch.id, 'terminal_create', 'The terminal never opened.')

    await expect(send(failed.dispatch.id, 'second')).resolves.toMatchObject({
      delivery: 'follow_up',
      followUpOf: failed.dispatch.id,
      effects: expect.arrayContaining([
        expect.objectContaining({ role: 'agent', id: 'term_worker' })
      ])
    })
  })

  it('takes mail for a working worker even when its report settles the Dispatch in the same turn', async () => {
    h.setup()
    const { taskId, dispatchId } = await h.startWorker()

    const sent = send(dispatchId, 'and the docs')
    h.settle(taskId, dispatchId, 'succeeded')

    await expect(sent).resolves.toMatchObject({ message: { to_handle: `dispatch:${dispatchId}` } })
  })

  it("keeps the conversation a kept worker's pane moves to after its report", async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    vi.mocked(h.runtime.getExactWorkerProviderSession).mockReturnValue({
      paneKey: h.workerPaneKey,
      agent: 'claude',
      processIncarnation: 'runtime_test:term_worker:1',
      providerSession: { key: 'session_id', id: 'after-clear' },
      observedAt: 1
    })

    captureMovedWorkerResumeSessions(h.runtime, h.db, [{ paneKey: h.workerPaneKey }])

    expect(
      readWorkerResumeSession(h.db.getWorkerTerminalResourceByOwner(dispatchId))
    ).toMatchObject({ agent: 'claude', providerSession: { id: 'after-clear' } })
  })
})
