import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { getWorkerTerminalAutoReleaseScheduler } from '../../../../../orchestration/terminal-authority/release/worker-terminal-auto-release-scheduler'
import { getFollowUpDispatch } from '../../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import './worker-resume-session-capture'
import { continueAllUnreadWorkerMail } from '../../messaging/settled-worker-follow-through'
import { createOrchestrationWorkerReleaseHarness } from '../testing/worker-release.test-support'

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
})
