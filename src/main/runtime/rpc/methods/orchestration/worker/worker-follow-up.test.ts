import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getWorkerTerminalAutoReleaseScheduler } from '../../../../orchestration/worker-terminal-auto-release-scheduler'
import {
  getFollowUpDispatch,
  readWorkerResumeSession
} from '../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import { watchMovedWorkerResumeSessions } from './worker-resume-session-capture'
import {
  continueAllUnreadWorkerMail,
  continueUnreadWorkerMail
} from '../messaging/settled-worker-follow-through'
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

  it('starts no second worker for one whose handle is gone until its process is proven exited', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    // As before a restart restores terminals: no handle resolves, but the process may still run.
    let gone = true
    const show = vi.mocked(h.runtime.showTerminal).getMockImplementation()!
    vi.mocked(h.runtime.showTerminal).mockImplementation(async (handle) => {
      if (gone && handle === 'term_worker') {
        throw new Error('terminal not found')
      }
      return show(handle)
    })
    vi.spyOn(h.runtime, 'resolveTerminalHandleByProcessIncarnation').mockReturnValue(null)

    await expect(send(dispatchId, 'and the docs')).rejects.toMatchObject({
      code: 'worker_unverifiable'
    })
    expect(getFollowUpDispatch(h.db, dispatchId)).toBeUndefined()
    expect(h.runtime.createTerminal).toHaveBeenCalledTimes(1)

    h.inspectProcessLiveness.mockResolvedValue('exited')
    vi.mocked(h.runtime.createTerminal).mockImplementationOnce(async () => {
      gone = false
      return { handle: 'term_worker', worktreeId: 'repo::worktree', title: 'worker' }
    })
    await expect(send(dispatchId, 'and the docs')).resolves.toMatchObject({
      delivery: 'started_fresh'
    })
  })

  it('starts no second worker while its pane cannot yet read the recorded process', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    vi.mocked(h.runtime.getTerminalProcessIncarnation).mockReturnValue(null)

    await expect(send(dispatchId, 'and the docs')).rejects.toMatchObject({
      code: 'worker_unverifiable'
    })
    expect(h.runtime.createTerminal).toHaveBeenCalledTimes(1)
  })

  it('keeps unread mail it could not continue, tells the coordinator, and delivers it with the next send', async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-follow-up-refused-'))
    h.setup({ userDataDir })
    const { taskId, dispatchId } = await h.startWorker()
    await send(dispatchId, 'DO NOT PUSH')
    h.settle(taskId, dispatchId, 'succeeded')

    h.restart()
    const verdict = vi.spyOn(h.runtime, 'getTerminalLivenessVerdict').mockReturnValue({
      status: 'unverifiable',
      reason: 'relay_dropped'
    })

    await vi.waitFor(() =>
      expect(h.db.getUnreadMessages(`run:${h.activeRunId}`)).toMatchObject([
        { type: 'escalation', subject: 'Mail did not reach the finished worker' }
      ])
    )
    expect(h.db.getDispatchContextById(dispatchId)?.follow_up_mail_at).not.toBeNull()
    expect(h.db.getUnreadMessages(`dispatch:${dispatchId}`)).toMatchObject([
      { body: 'DO NOT PUSH' }
    ])

    verdict.mockRestore()
    await send(dispatchId, 'and the docs')
    const followUpId = getFollowUpDispatch(h.db, dispatchId)!.id
    await vi.waitFor(() =>
      expect(h.db.getUnreadMessages(`dispatch:${followUpId}`)).toMatchObject([
        { body: 'DO NOT PUSH' }
      ])
    )
    expect(h.db.getDispatchContextById(dispatchId)?.follow_up_mail_at).toBeNull()
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

  it('holds unread mail for a follow-up another send is starting and moves it in once that one is ready', async () => {
    h.setup()
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
    const arrived = vi.mocked(h.runtime.notifyMessageArrived)
    arrived.mockClear()

    continueAllUnreadWorkerMail(h.runtime, h.db)
    expect(h.db.getUnreadMessages(`dispatch:${dispatchId}`)).toMatchObject([
      { body: 'and the docs' }
    ])
    expect(h.db.getDispatchContextById(dispatchId)?.follow_up_mail_at).not.toBeNull()

    h.db.markWorkerDispatchReady(winner.dispatch.id)
    continueAllUnreadWorkerMail(h.runtime, h.db)
    continueAllUnreadWorkerMail(h.runtime, h.db)
    expect(h.db.getUnreadMessages(`dispatch:${winner.dispatch.id}`)).toMatchObject([
      { body: 'and the docs' }
    ])
    expect(arrived.mock.calls).toEqual([[`dispatch:${winner.dispatch.id}`, 'status']])
    expect(h.db.getDispatchContextById(dispatchId)?.follow_up_mail_at).toBeNull()
  })

  it('counts a follow-up that reported before its start was observed as having taken the mail', async () => {
    h.setup()
    const { taskId, dispatchId } = await h.startWorker()
    await send(dispatchId, 'DO NOT PUSH')
    h.settle(taskId, dispatchId, 'succeeded')
    vi.mocked(h.runtime.sendTerminalAgentPrompt).mockImplementationOnce(async (handle) => {
      const followUp = getFollowUpDispatch(h.db, dispatchId)!
      h.settle(followUp.task_id, followUp.id, 'succeeded')
      return { handle, accepted: true, bytesWritten: 1 }
    })

    continueAllUnreadWorkerMail(h.runtime, h.db)

    await vi.waitFor(() =>
      expect(h.db.getDispatchContextById(dispatchId)?.follow_up_mail_at).toBeNull()
    )
    const followUp = getFollowUpDispatch(h.db, dispatchId)!
    expect(h.db.getTask(followUp.task_id)?.spec).toContain('DO NOT PUSH')
    expect(h.db.getUnreadMessages(`dispatch:${dispatchId}`)).toHaveLength(0)
    expect(h.db.getUnreadMessages(`dispatch:${followUp.id}`)).toHaveLength(0)
    expect(h.db.getUnreadMessages(`run:${h.activeRunId}`)).toHaveLength(0)
  })

  it('keeps the mail a failed follow-up took when a replayed report ran during its start', async () => {
    h.setup()
    const { taskId, dispatchId } = await h.startWorker()
    await send(dispatchId, 'DO NOT PUSH')
    h.settle(taskId, dispatchId, 'succeeded')
    vi.mocked(h.runtime.sendTerminalAgentPrompt).mockImplementationOnce(async () => {
      // The replay finds no unread mail, since the start took it, and clears the marker.
      continueUnreadWorkerMail(h.runtime, h.db, dispatchId)
      throw new Error('prompt lost')
    })

    continueAllUnreadWorkerMail(h.runtime, h.db)

    await vi.waitFor(() => expect(getFollowUpDispatch(h.db, dispatchId)).toBeDefined())
    const failed = getFollowUpDispatch(h.db, dispatchId)!.id
    await vi.waitFor(() =>
      expect(h.db.getUnreadMessages(`dispatch:${failed}`)).toMatchObject([{ body: 'DO NOT PUSH' }])
    )
  })

  it('keeps the mail a failed follow-up took, says so, and delivers it with the retry', async () => {
    h.setup()
    const { taskId, dispatchId } = await h.startWorker()
    await send(dispatchId, 'DO NOT PUSH')
    h.settle(taskId, dispatchId, 'succeeded')
    vi.mocked(h.runtime.sendTerminalAgentPrompt).mockRejectedValueOnce(new Error('prompt lost'))

    continueAllUnreadWorkerMail(h.runtime, h.db)

    await vi.waitFor(() =>
      expect(h.db.getUnreadMessages(`run:${h.activeRunId}`)).toMatchObject([
        { type: 'escalation', subject: 'Mail did not reach the finished worker' }
      ])
    )
    const failed = getFollowUpDispatch(h.db, dispatchId)!.id
    expect(h.db.getUnreadMessages(`dispatch:${failed}`)).toMatchObject([{ body: 'DO NOT PUSH' }])

    // The coordinator retries at the address it knows; the retry follows the failed follow-up.
    await send(dispatchId, 'and the docs')
    const retry = getFollowUpDispatch(h.db, failed)!.id
    await vi.waitFor(() =>
      expect(h.db.getUnreadMessages(`dispatch:${retry}`)).toMatchObject([{ body: 'DO NOT PUSH' }])
    )
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

    watchMovedWorkerResumeSessions(
      h.runtime,
      () => h.db
    )([{ paneKey: h.workerPaneKey, sessionId: 'after-clear' }])

    expect(
      readWorkerResumeSession(h.db.getWorkerTerminalResourceByOwner(dispatchId))
    ).toMatchObject({ agent: 'claude', providerSession: { id: 'after-clear' } })
  })

  it('saves nothing again when a status change repeats the same conversations', async () => {
    h.setup()
    await h.startSettledWorker()
    const read = vi.mocked(h.runtime.getExactWorkerProviderSession)
    const notify = watchMovedWorkerResumeSessions(h.runtime, () => h.db)
    const sessions = [{ paneKey: h.workerPaneKey, sessionId: 'after-clear' }]

    notify(sessions)
    read.mockClear()
    notify(sessions)

    expect(read).not.toHaveBeenCalled()
  })
})
