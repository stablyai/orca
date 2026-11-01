import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES } from '../../../../../../shared/orchestration-worker-start-prompt-budget'
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
    expect(h.db.getTask(followUp.task_id)?.spec).toContain('`check` command above')
    await vi.waitFor(() =>
      expect(h.db.getDispatchContextById(dispatchId)?.follow_up_mail_at).toBeNull()
    )
    expect(h.db.getUnreadMessages(`dispatch:${dispatchId}`)).toHaveLength(0)
    expect(h.db.getUnreadMessages(`dispatch:${followUp.id}`)).toMatchObject([
      { body: 'and the docs' }
    ])
  })

  it('starts a follow-up for a backlog larger than any Task and hands all of it to check', async () => {
    h.setup()
    const { taskId, dispatchId } = await h.startWorker()
    const large = 'x'.repeat(Math.ceil(ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES / 10))
    for (let index = 0; index < 25; index += 1) {
      await send(dispatchId, `${index} ${large}`)
    }
    // The worker was woken for this mail before it reported, as a live worker is.
    h.db.markAsDelivered(
      h.db.getUnreadMessages(`dispatch:${dispatchId}`).map((message) => message.id),
      `dispatch:${dispatchId}`
    )
    h.settle(taskId, dispatchId, 'succeeded')

    continueAllUnreadWorkerMail(h.runtime, h.db)

    await vi.waitFor(() =>
      expect(h.db.getDispatchContextById(dispatchId)?.follow_up_mail_at).toBeNull()
    )
    const followUp = getFollowUpDispatch(h.db, dispatchId)!
    expect(h.db.getTask(followUp.task_id)?.spec).not.toContain(large)
    expect(
      JSON.stringify(vi.mocked(h.runtime.sendTerminalAgentPrompt).mock.calls.at(-1))
    ).toContain(
      '# Messages for this task are waiting; read them:\\n  orca orchestration check --terminal term_worker'
    )
    // Its start prompt is the wake, so no pointer types over the turn it starts.
    expect(h.db.getUndeliveredUnreadMessages(`dispatch:${followUp.id}`)).toHaveLength(0)
    expect(
      h.db
        .getUnreadMessages(`dispatch:${followUp.id}`)
        .map((message) => message.body?.split(' ')[0])
    ).toEqual(Array.from({ length: 25 }, (_, index) => String(index)))
  })

  it('retries a follow-up a restart interrupted before it placed an agent, with the mail it took', async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-follow-up-midstart-'))
    h.setup({ userDataDir })
    const { taskId, dispatchId } = await h.startWorker()
    await send(dispatchId, 'DO NOT PUSH')
    h.settle(taskId, dispatchId, 'succeeded')
    // The claim commits; the app quits before the start places an agent.
    const claimed = h.db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 9,
      taskSpec: 'New messages',
      taskRunId: h.activeRunId,
      startOptions: { agent: 'codex' },
      runtimeEpoch: 'runtime_before_restart',
      followUpOf: dispatchId,
      takesMailOf: dispatchId
    }).dispatch.id

    h.restart()

    await vi.waitFor(() => expect(getFollowUpDispatch(h.db, claimed)).toBeDefined())
    const retry = getFollowUpDispatch(h.db, claimed)!
    await vi.waitFor(() =>
      expect(h.db.getUnreadMessages(`dispatch:${retry.id}`)).toMatchObject([
        { body: 'DO NOT PUSH' }
      ])
    )
  })

  it('keeps the mail a stopped follow-up never read for the next send, without restarting it', async () => {
    h.setup()
    const { taskId, dispatchId } = await h.startWorker()
    await send(dispatchId, 'DO NOT PUSH')
    h.settle(taskId, dispatchId, 'succeeded')
    continueAllUnreadWorkerMail(h.runtime, h.db)
    await vi.waitFor(() =>
      expect(h.db.getWorkerDispatch(getFollowUpDispatch(h.db, dispatchId)?.id ?? '')?.state).toBe(
        'ready'
      )
    )
    const stopped = getFollowUpDispatch(h.db, dispatchId)!.id
    h.db.beginWorkerStop(stopped, h.runtime.getRuntimeId())
    h.db.settleWorkerStop(stopped)

    continueAllUnreadWorkerMail(h.runtime, h.db)
    expect(getFollowUpDispatch(h.db, stopped)).toBeUndefined()

    await send(dispatchId, 'and the docs')
    const next = getFollowUpDispatch(h.db, stopped)!
    await vi.waitFor(() =>
      expect(h.db.getUnreadMessages(`dispatch:${next.id}`)).toMatchObject([{ body: 'DO NOT PUSH' }])
    )
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

  it('asks the coordinator instead of restarting a follow-up that reported without reading its mail', async () => {
    h.setup()
    const { taskId, dispatchId } = await h.startWorker()
    await send(dispatchId, 'DO NOT PUSH')
    // Sent before the follow-up starts, as anything it takes is.
    h.db.db.prepare("UPDATE messages SET created_at = datetime('now', '-1 minute')").run()
    h.settle(taskId, dispatchId, 'succeeded')
    vi.mocked(h.runtime.sendTerminalAgentPrompt).mockImplementationOnce(async (handle) => {
      const followUp = getFollowUpDispatch(h.db, dispatchId)!
      h.settle(followUp.task_id, followUp.id, 'succeeded')
      return { handle, accepted: true, bytesWritten: 1 }
    })

    continueAllUnreadWorkerMail(h.runtime, h.db)

    await vi.waitFor(() =>
      expect(h.db.getUnreadMessages(`run:${h.activeRunId}`)).toMatchObject([
        { type: 'escalation', subject: 'Mail did not reach the finished worker' }
      ])
    )
    const followUp = getFollowUpDispatch(h.db, dispatchId)!
    expect(getFollowUpDispatch(h.db, followUp.id)).toBeUndefined()
    expect(h.db.getUnreadMessages(`dispatch:${followUp.id}`)).toMatchObject([
      { body: 'DO NOT PUSH' }
    ])

    // Mail newer than that follow-up still continues it, carrying the unread mail along.
    await send(followUp.id, 'and the docs')
    const next = getFollowUpDispatch(h.db, followUp.id)!
    await vi.waitFor(() =>
      expect(h.db.getUnreadMessages(`dispatch:${next.id}`)).toMatchObject([{ body: 'DO NOT PUSH' }])
    )
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

  it('moves held mail as new to a follow-up already running, except a pointer whose Enter is in flight', async () => {
    h.setup()
    const { taskId, dispatchId } = await h.startWorker()
    await send(dispatchId, 'typed, Enter in flight')
    await send(dispatchId, 'woken before')
    const [inFlight, delivered] = h.db.getUnreadMessages(`dispatch:${dispatchId}`)
    h.db.db
      .prepare(
        "UPDATE messages SET pointer_enter_pending = 3, pointer_pty_id = 'pty_old' WHERE id = ?"
      )
      .run(inFlight!.id)
    h.db.markAsDelivered([delivered!.id], `dispatch:${dispatchId}`)
    h.settle(taskId, dispatchId, 'succeeded')
    const winner = h.db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 9,
      taskSpec: 'first',
      taskRunId: h.activeRunId,
      startOptions: { agent: 'codex' },
      followUpOf: dispatchId
    })
    h.db.markWorkerDispatchReady(winner.dispatch.id)

    continueAllUnreadWorkerMail(h.runtime, h.db)

    expect(h.db.getMessageById(inFlight!.id)).toMatchObject({
      to_handle: `dispatch:${winner.dispatch.id}`,
      pointer_enter_pending: 3,
      pointer_pty_id: 'pty_old'
    })
    expect(h.db.getMessageById(delivered!.id)).toMatchObject({
      to_handle: `dispatch:${winner.dispatch.id}`,
      delivered_at: null
    })
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
