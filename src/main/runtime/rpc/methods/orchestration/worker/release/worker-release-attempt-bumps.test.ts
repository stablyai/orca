import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import '../../../../../orchestration/db/contract-constants'
import '../../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../../orchestration/db/attempt-outcome-projection'
import { insertRemoteDispatchAttachmentRow } from '../../../../../orchestration/db/dispatch-row-writer'
import { bindWorkerTerminal } from '../../../../../orchestration/db/worker-terminal/worker-bound-terminals'
import { readWorkerTerminalReleaseAttempt } from '../../../../../orchestration/db/worker-terminal/worker-terminal-release-attempt'
import {
  createWorkerReleaseFixture,
  workerPaneKey,
  type WorkerReleaseFixture
} from './worker-release.test-fixture'

const devPaneKey = 'tab_dev:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const workerGeneration = '11111111-1111-4111-8111-111111111111'

describe('the keep-open revision', () => {
  let fixture: WorkerReleaseFixture
  let db: OrchestrationDb

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  async function worker(settled = false) {
    fixture = createWorkerReleaseFixture()
    db = fixture.db
    const { dispatchId, taskId } = await (settled
      ? fixture.startSettledWorker()
      : fixture.startWorker())
    // The worker's process is still running, so nothing here proves an exit.
    fixture.loseWorkerTerminal(async () => ({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the exit proof reads only id and incarnation.
      processes: [
        { id: 'pty-worker', incarnationId: workerGeneration, cwd: '', title: '' }
      ] as never[],
      inProcessOwner: false
    }))
    const resource = db.getWorkerTerminalResourceByOwner(dispatchId)!
    return {
      dispatchId,
      taskId,
      resourceId: resource.id,
      origin: resource.origin_dispatch_id,
      revision: () => readWorkerTerminalReleaseAttempt(db, resource.id),
      revisions: () =>
        Number(db.db.prepare('SELECT COUNT(*) AS n FROM worker_terminal_release_attempts').get()?.n)
    }
  }

  const setRow = (resourceId: string, assignments: string) =>
    db.db
      .prepare(`UPDATE worker_terminal_resources SET ${assignments} WHERE id = ?`)
      .run(resourceId)

  it('rises by one per applied worker-keep-open, a repeat on the same state included', async () => {
    const w = await worker(true)
    expect(w.revision()).toBe(0)
    for (const expected of [1, 2, 3]) {
      await expect(
        fixture.call('orchestration.workerRetain', { dispatch: w.dispatchId })
      ).resolves.toMatchObject({ state: 'retained', reason: 'user_requested' })
      expect(w.revision()).toBe(expected)
    }
    expect(w.revisions()).toBe(1)
  })

  it("rises by one when the execution host applies a remote home's keep-open", async () => {
    const w = await worker(true)
    insertRemoteDispatchAttachmentRow(db.db, {
      dispatchId: w.dispatchId,
      runId: fixture.activeRunId,
      taskId: w.taskId,
      homePeerFingerprint: 'home_peer',
      protocolVersion: 1,
      runtimeEpoch: 'epoch_1',
      depth: 1
    })
    const remoteRetain = vi.spyOn(db, 'retainRemoteAttachmentTerminalResource')

    await expect(
      fixture.call('orchestration.workerRetain', { dispatch: w.dispatchId })
    ).resolves.toMatchObject({ state: 'retained' })
    expect(remoteRetain).toHaveBeenCalledOnce()
    expect(w.revision()).toBe(1)
  })

  it("rises by one for Keep open on the worker's own pane, and not on a pane it cannot keep", async () => {
    const w = await worker(true)
    await fixture.call('orchestration.workerKeepOpen', { paneKey: workerPaneKey, keep: true })
    expect(db.getWorkerTerminalResource(w.resourceId)).toMatchObject({
      release_state: 'retained',
      retained_reason: 'user_kept'
    })
    expect(w.revision()).toBe(1)

    // Already kept: the pane's resource no longer matches what Keep open applies to.
    await fixture.call('orchestration.workerKeepOpen', { paneKey: workerPaneKey, keep: true })
    expect(w.revision()).toBe(1)
  })

  it('stays put for Keep open on a pane only bound to the worker, which unbinds it', async () => {
    const w = await worker(true)
    const original = vi.mocked(fixture.runtime.getTerminalPaneKey).getMockImplementation()!
    vi.mocked(fixture.runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_dev' ? devPaneKey : original(handle)
    )
    bindWorkerTerminal(db, {
      dispatchId: w.origin,
      terminalHandle: 'term_dev',
      paneKey: devPaneKey,
      role: 'created'
    })

    await fixture.call('orchestration.workerKeepOpen', { paneKey: devPaneKey, keep: true })

    expect(
      db.db
        .prepare('SELECT 1 FROM worker_bound_terminals WHERE terminal_handle = ?')
        .get('term_dev')
    ).toBeUndefined()
    expect(w.revisions()).toBe(0)
  })

  it('rises by one when Abandon hands an owned terminal back, and not on a repeat', async () => {
    const w = await worker()
    await expect(
      fixture.call('orchestration.workerAbandon', { dispatch: w.dispatchId })
    ).resolves.toMatchObject({ state: 'abandoned' })
    expect(db.getWorkerTerminalResource(w.resourceId)?.release_state).toBe('retained')
    expect(w.revision()).toBe(1)

    await fixture.call('orchestration.workerAbandon', { dispatch: w.dispatchId })
    expect(w.revision()).toBe(1)
  })

  it('stays put when Abandon finds the worker already settled', async () => {
    const w = await worker(true)
    await fixture.call('orchestration.workerAbandon', { dispatch: w.dispatchId })
    expect(db.getWorkerDispatch(w.dispatchId)?.state).toBe('succeeded')
    expect(w.revisions()).toBe(0)
  })

  for (const [label, assignments, receipt] of [
    ['released', "release_state = 'released', ownership_state = 'released'", 'already_released'],
    ['release-committed', "release_state = 'releasing'", 'release_pending']
  ] as const) {
    it(`stays put when worker-keep-open meets a ${label} row`, async () => {
      const w = await worker(true)
      setRow(w.resourceId, assignments)
      await expect(
        fixture.call('orchestration.workerRetain', { dispatch: w.dispatchId })
      ).resolves.toMatchObject({ state: receipt })
      expect(w.revisions()).toBe(0)
    })
  }

  it('stays put when worker-keep-open finds no owned terminal', async () => {
    const w = await worker(true)
    db.db.prepare('DELETE FROM worker_terminal_resources WHERE id = ?').run(w.resourceId)
    await expect(
      fixture.call('orchestration.workerRetain', { dispatch: w.dispatchId })
    ).resolves.toMatchObject({ state: 'retained', reason: 'no_owned_resource' })
    expect(w.revisions()).toBe(0)
  })

  it('rolls back with the keep-open when a later write in its transaction fails', async () => {
    const w = await worker(true)
    await fixture.call('orchestration.workerRetain', { dispatch: w.dispatchId })
    setRow(w.resourceId, "release_state = 'not_requested', retained_reason = NULL")
    db.storeWorkerTerminalArchive({
      dispatchId: w.dispatchId,
      resourceId: w.resourceId,
      kind: 'terminal_tail',
      content: '{}'
    })
    const before = db.db
      .prepare('SELECT * FROM worker_terminal_resources WHERE id = ?')
      .get(w.resourceId)
    // Fails the archive drop that follows the revision write.
    db.db.exec(`CREATE TEMP TRIGGER fail_archive_drop BEFORE DELETE ON main.worker_terminal_archives
      BEGIN SELECT RAISE(ABORT, 'injected fault'); END`)

    await expect(
      fixture.call('orchestration.workerRetain', { dispatch: w.dispatchId })
    ).rejects.toThrow('injected fault')

    expect(
      db.db.prepare('SELECT * FROM worker_terminal_resources WHERE id = ?').get(w.resourceId)
    ).toEqual(before)
    expect(w.revision()).toBe(1)
  })
})
