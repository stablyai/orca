import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../../orca-runtime'
import '../../../../../orchestration/db/contract-constants'
import '../../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../../orchestration/db/dispatch-row-writer'
import '../../../../../orchestration/db/attempt-outcome-projection'
import type { PtyProcessInfo } from '../../../../../../providers/pty/process-info'
import { reconcileRequestedWorkerTerminalReleases } from '../../../../../orchestration/terminal-authority/release/worker-terminal-release-reconciliation'
import { sweepStoppedWorkerTerminals } from '../../../../../orchestration/terminal-authority/release/stopped-worker-terminal-release'
import { completeWorkerTerminalRelease } from './worker-release-completion'
import {
  createWorkerReleaseFixture,
  deferred,
  isStartReceipt,
  workerIncarnation,
  workerPaneKey,
  type WorkerReleaseFixture
} from './worker-release.test-fixture'

const workerGeneration = '11111111-1111-4111-8111-111111111111'

/** Release must act on, and report, only its own dispatch's custody of a worker terminal. */
describe('worker release stays within its own custody', () => {
  let db: OrchestrationDb
  let dbOpen = false
  let runtime: OrcaRuntimeService
  let activeRunId: string
  let fixture: WorkerReleaseFixture

  function setup(): void {
    fixture = createWorkerReleaseFixture()
    ;({ db, runtime, activeRunId } = fixture)
    dbOpen = true
  }

  afterEach(() => {
    if (dbOpen) {
      dbOpen = false
      db.close()
    }
    vi.restoreAllMocks()
  })

  const call = (name: string, params: Record<string, unknown>) => fixture.call(name, params)
  const startSettledWorker = () => fixture.startSettledWorker()
  const loseWorkerTerminal: WorkerReleaseFixture['loseWorkerTerminal'] = (listing) =>
    fixture.loseWorkerTerminal(listing)
  const goneAfterSettle = () => fixture.goneAfterSettle()

  it('shares one proof between two joined releases of a finished worker; only one reports released', async () => {
    setup()
    const listing = deferred<{ processes: never[]; inProcessOwner: boolean }>()
    const proving = vi.fn(() => listing.promise)
    loseWorkerTerminal(proving)
    const { dispatchId } = await startSettledWorker()
    goneAfterSettle()

    const first = call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() => expect(proving).toHaveBeenCalledTimes(1))
    const second = call('orchestration.workerRelease', { dispatch: dispatchId })
    listing.resolve({ processes: [], inProcessOwner: false })

    await expect(first).resolves.toMatchObject({ state: 'released' })
    await expect(second).resolves.toMatchObject({ state: 'already_released' })
    expect(proving).toHaveBeenCalledTimes(1)
    expect(
      vi
        .mocked(runtime.notifyMessageArrived)
        .mock.calls.filter(
          ([target, kind]) => target === `dispatch:${dispatchId}` && kind === 'status'
        )
    ).toHaveLength(1)
  })

  /** A new worker reuses the worker's terminal: worker-start transfers its custody. */
  async function reuseTerminal(): Promise<{ taskId: string; dispatchId: string }> {
    const task = db.createTask({ spec: 'reuses the kept terminal', runId: activeRunId })
    // The terminal resolves again for the reuse, then is gone once more.
    fixture.terminalBack()
    const started: unknown = await call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      terminal: 'term_worker'
    })
    goneAfterSettle()
    if (!isStartReceipt(started)) {
      throw new Error('worker start returned no receipt')
    }
    expect(db.getWorkerTerminalResourceByOwner(started.dispatchId)).toBeDefined()
    return { taskId: task.id, dispatchId: started.dispatchId }
  }

  /** The coordinator keeps the worker, then a new worker reuses its terminal. */
  async function transferWhileProving(
    from: string
  ): Promise<{ taskId: string; dispatchId: string }> {
    await call('orchestration.workerRetain', { dispatch: from })
    return reuseTerminal()
  }

  it("reports a requested release's transfer as ownership_transferred and leaves the new owner's row alone", async () => {
    setup()
    const listing = deferred<{ processes: never[]; inProcessOwner: boolean }>()
    const proving = vi.fn(() => listing.promise)
    loseWorkerTerminal(proving)
    const { dispatchId } = await startSettledWorker()
    goneAfterSettle()

    const release = call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() => expect(proving).toHaveBeenCalled())
    const { dispatchId: successor } = await transferWhileProving(dispatchId)
    const before = db.getWorkerTerminalResourceByOwner(successor)
    listing.resolve({ processes: [], inProcessOwner: false })

    await expect(release).resolves.toMatchObject({
      dispatchId,
      state: 'retained',
      reason: 'ownership_transferred',
      archive: null
    })
    expect(db.getWorkerTerminalResourceByOwner(successor)).toEqual(before)
  })

  it("never hands a successor's release the predecessor's pending proof or receipt", async () => {
    setup()
    const proofs: ReturnType<
      typeof deferred<{ processes: PtyProcessInfo[]; inProcessOwner: boolean }>
    >[] = []
    loseWorkerTerminal(() => {
      proofs.push(deferred())
      return proofs.at(-1)!.promise
    })
    const { dispatchId } = await startSettledWorker()
    goneAfterSettle()

    const release = call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() => expect(proofs).toHaveLength(1))
    const { taskId, dispatchId: successor } = await transferWhileProving(dispatchId)
    db.settleWorkerReport({
      taskId,
      dispatchId: successor,
      outcome: 'succeeded',
      result: 'successor done'
    })
    const successorRelease = call('orchestration.workerRelease', { dispatch: successor })
    // Its own proof, not a join onto the predecessor's.
    await vi.waitFor(() => expect(proofs).toHaveLength(2))
    // The predecessor's proof answers first, and the worker is still alive.
    const alive = [{ id: 'pty-worker', incarnationId: workerGeneration, cwd: '', title: '' }]
    proofs[0]!.resolve({ processes: alive, inProcessOwner: false })
    await expect(release).resolves.toMatchObject({ dispatchId, reason: 'ownership_transferred' })
    expect(db.getWorkerTerminalResourceByOwner(successor)?.release_state).toBe('requested')

    proofs[1]!.resolve({ processes: [], inProcessOwner: false })
    await expect(successorRelease).resolves.toMatchObject({
      dispatchId: successor,
      state: 'released'
    })
  })

  it('never lets a former owner release the resource its successor now holds', async () => {
    setup()
    loseWorkerTerminal(async () => ({ processes: [], inProcessOwner: false }))
    const { dispatchId } = await startSettledWorker()
    const { taskId, dispatchId: successor } = await transferWhileProving(dispatchId)
    db.settleWorkerReport({
      taskId,
      dispatchId: successor,
      outcome: 'succeeded',
      result: 'successor done'
    })
    const resourceId = db.getWorkerTerminalResourceByOwner(successor)!.id
    // The successor holds a matching archive, and its exact process is proven gone.
    db.storeWorkerTerminalArchiveBeforeStop({
      dispatchId: successor,
      resourceId,
      kind: 'terminal_tail',
      content: '{"version":3,"fallbackReason":"session_not_reported"}',
      archiveSource: 'terminal',
      archiveStatus: 'unavailable'
    })
    goneAfterSettle()
    const before = db.getWorkerTerminalResource(resourceId)
    const archive = db.getWorkerTerminalArchive(successor)

    // Transferred before this call: the lookup keeps its lineage summary, as it always has.
    await expect(
      call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({
      state: 'retained',
      reason: 'ownership_transferred',
      archive: { source: 'terminal', status: 'unavailable' }
    })
    expect(db.getWorkerTerminalResource(resourceId)).toEqual(before)
    expect(db.getWorkerTerminalArchive(successor)).toEqual(archive)
    expect(runtime.notifyMessageArrived).not.toHaveBeenCalledWith(
      `dispatch:${dispatchId}`,
      'status'
    )
  })

  it('reports a transfer that landed while a live observation was pending, and closes nothing', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    const observed = deferred<unknown>()
    const shown = vi.mocked(runtime.showTerminal).mock.calls.length
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: release reads only the handle, worktree and status of a shown terminal.
    vi.mocked(runtime.showTerminal).mockImplementationOnce(() => observed.promise as never)

    const release = call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() =>
      expect(vi.mocked(runtime.showTerminal).mock.calls.length).toBeGreaterThan(shown)
    )
    const { dispatchId: successor } = await transferWhileProving(dispatchId)
    fixture.terminalBack()
    const before = db.getWorkerTerminalResourceByOwner(successor)
    // The pane now names a conversation: a stale capture would save it into the successor's row.
    vi.mocked(runtime.getExactWorkerProviderSession).mockReturnValue(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resume capture reads only these session fields.
      {
        paneKey: workerPaneKey,
        processIncarnation: workerIncarnation,
        connectionId: null,
        agent: 'claude',
        providerSession: {
          key: 'session_id',
          id: 'predecessor-session',
          transcriptPath: '/tmp/p.jsonl'
        },
        observedAt: 0
      } as never
    )
    observed.resolve({ handle: 'term_worker', worktreeId: 'repo::worktree', status: 'running' })

    await expect(release).resolves.toMatchObject({
      dispatchId,
      state: 'retained',
      reason: 'ownership_transferred',
      processAction: 'none',
      archive: null
    })
    expect(db.getWorkerTerminalResourceByOwner(successor)).toEqual(before)
    expect(db.getWorkerTerminalArchive(successor)).toBeUndefined()
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it.each(['killed', 'unconfirmed', 'unreachable'] as const)(
    'reports the Keep open that won during an automatic close (%s), and announces no release',
    async (outcome) => {
      setup()
      vi.spyOn(runtime, 'isWorkerAgentInTurn').mockReturnValue(false)
      const { dispatchId } = await startSettledWorker()
      db.db
        .prepare(
          `UPDATE worker_terminal_resources SET auto_release_at = datetime('now', '-1 minute'),
             auto_release_dispatch_id = owner_dispatch_id WHERE owner_dispatch_id = ?`
        )
        .run(dispatchId)
      expect(db.claimDueWorkerTerminalAutoReleases(Date.now())).toBe(1)
      const closing = deferred<{ handle: string; tabId: string; ptyKilled: boolean }>()
      vi.mocked(runtime.closeTerminal).mockImplementationOnce(() => closing.promise)
      const notified = vi.mocked(runtime.notifyMessageArrived).mock.calls.length

      const recovery = reconcileRequestedWorkerTerminalReleases(runtime)
      await vi.waitFor(() => expect(runtime.closeTerminal).toHaveBeenCalledTimes(1))
      await call('orchestration.workerKeepOpen', { paneKey: workerPaneKey, keep: true })
      if (outcome === 'unreachable') {
        closing.reject(new Error('Terminal endpoint not connected'))
      } else {
        closing.resolve({
          handle: 'term_worker',
          tabId: 'tab-worker',
          ptyKilled: outcome === 'killed'
        })
      }

      // Kept, not released and not release_unknown: the close already ran, and the receipt says so.
      await expect(recovery).resolves.toMatchObject({
        attempted: 1,
        released: 0,
        unknown: 0,
        pending: 0,
        retained: 1
      })
      expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
        ownership_state: 'owned',
        release_state: 'retained',
        retained_reason: 'user_kept'
      })
      expect(
        vi
          .mocked(runtime.notifyMessageArrived)
          .mock.calls.slice(notified)
          .filter(([target, kind]) => target === `dispatch:${dispatchId}` && kind === 'status')
      ).toEqual([])
      // Only the agent's own terminal closed: a release that did not land runs no bound-pane cleanup.
      expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
    }
  )

  it("never lets a release's settle reach a successor's row through the installed database", async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    const { taskId, dispatchId: successor } = await reuseTerminal()
    db.settleWorkerReport({ taskId, dispatchId: successor, outcome: 'succeeded', result: 'done' })
    expect(db.requestWorkerTerminalRelease(successor).disposition).toBe('requested')
    const resourceId = db.getWorkerTerminalResourceByOwner(successor)!.id
    const before = db.getWorkerTerminalResource(resourceId)

    // The crew notification wrapper sits on these methods; the predecessor's owner fence must survive it.
    expect(db.settleWorkerTerminalRelease(resourceId, dispatchId)).toEqual(before)
    expect(db.markWorkerTerminalReleaseUnknown(resourceId, 'stale', dispatchId)).toEqual(before)
    expect(
      db.revertWorkerTerminalReleaseToRetained(resourceId, 'identity_unproven', dispatchId)
    ).toEqual(before)
    expect(db.settleWorkerTerminalRelease(resourceId, successor).release_state).toBe('released')
  })

  it('keeps a fresh release that joined a held automatic close pending when that close fails transiently', async () => {
    setup()
    vi.spyOn(runtime, 'isWorkerAgentInTurn').mockReturnValue(false)
    const { dispatchId } = await startSettledWorker()
    db.db
      .prepare(
        `UPDATE worker_terminal_resources SET auto_release_at = datetime('now', '-1 minute'),
           auto_release_dispatch_id = owner_dispatch_id WHERE owner_dispatch_id = ?`
      )
      .run(dispatchId)
    expect(db.claimDueWorkerTerminalAutoReleases(Date.now())).toBe(1)
    const closing = deferred<{ handle: string; tabId: string; ptyKilled: boolean }>()
    vi.mocked(runtime.closeTerminal).mockImplementationOnce(() => closing.promise)

    const recovery = reconcileRequestedWorkerTerminalReleases(runtime)
    await vi.waitFor(() => expect(runtime.closeTerminal).toHaveBeenCalledTimes(1))
    // Keep open, then Allow Auto-Close, then the coordinator asks again: a fresh request joins the held close.
    await call('orchestration.workerKeepOpen', { paneKey: workerPaneKey, keep: true })
    await call('orchestration.workerKeepOpen', { paneKey: workerPaneKey, keep: false })
    const fresh = call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() =>
      expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('requested')
    )
    closing.reject(new Error('Terminal endpoint not connected'))

    await expect(fresh).resolves.toMatchObject({
      dispatchId,
      state: 'release_pending',
      processAction: 'none'
    })
    await expect(recovery).resolves.toMatchObject({ attempted: 1, pending: 1, retained: 0 })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('requested')
    // The pending intent is still recovery's to finish.
    await expect(reconcileRequestedWorkerTerminalReleases(runtime)).resolves.toMatchObject({
      attempted: 1,
      released: 1
    })
  })

  it.each(['killed', 'unconfirmed', 'failed'] as const)(
    "reports a close that lost custody (%s) as transferred, never with the successor's state or error",
    async (outcome) => {
      setup()
      vi.spyOn(runtime, 'isWorkerAgentInTurn').mockReturnValue(false)
      const { dispatchId } = await startSettledWorker()
      db.db
        .prepare(
          `UPDATE worker_terminal_resources SET auto_release_at = datetime('now', '-1 minute'),
             auto_release_dispatch_id = owner_dispatch_id WHERE owner_dispatch_id = ?`
        )
        .run(dispatchId)
      expect(db.claimDueWorkerTerminalAutoReleases(Date.now())).toBe(1)
      const closing = deferred<{ handle: string; tabId: string; ptyKilled: boolean }>()
      vi.mocked(runtime.closeTerminal).mockImplementationOnce(() => closing.promise)
      const notified = vi.mocked(runtime.notifyMessageArrived).mock.calls.length

      const completion = completeWorkerTerminalRelease({
        runtime,
        db,
        dispatchId,
        resource: db.getWorkerTerminalResourceByOwner(dispatchId)!,
        mode: 'recovery'
      })
      await vi.waitFor(() => expect(runtime.closeTerminal).toHaveBeenCalledTimes(1))
      // Keep open wins the row, a new worker reuses the kept terminal, and its own release goes unknown.
      await call('orchestration.workerKeepOpen', { paneKey: workerPaneKey, keep: true })
      const { taskId, dispatchId: successor } = await reuseTerminal()
      db.settleWorkerReport({ taskId, dispatchId: successor, outcome: 'succeeded', result: 'done' })
      const resourceId = db.getWorkerTerminalResourceByOwner(successor)!.id
      db.db
        .prepare(
          `UPDATE worker_terminal_resources SET release_state = 'unknown', retained_reason = NULL,
             release_error = 'successor close was not proven' WHERE id = ?`
        )
        .run(resourceId)
      const before = db.getWorkerTerminalResource(resourceId)
      if (outcome === 'failed') {
        closing.reject(new Error('close exploded'))
      } else {
        closing.resolve({
          handle: 'term_worker',
          tabId: 'tab-worker',
          ptyKilled: outcome === 'killed'
        })
      }

      const receipt = await completion
      expect(receipt).toMatchObject({
        dispatchId,
        state: 'retained',
        reason: 'ownership_transferred',
        archive: null
      })
      expect(receipt.lastError).toBeUndefined()
      expect(db.getWorkerTerminalResource(resourceId)).toEqual(before)
      expect(
        vi
          .mocked(runtime.notifyMessageArrived)
          .mock.calls.slice(notified)
          .filter(([target, kind]) => target === `dispatch:${dispatchId}` && kind === 'status')
      ).toEqual([])
    }
  )

  it("reports a transfer during a stopped worker's own proof without the successor's output summary", async () => {
    setup()
    const listing = deferred<{ processes: PtyProcessInfo[]; inProcessOwner: boolean }>()
    const proving = vi.fn(() => listing.promise)
    loseWorkerTerminal(proving)
    const { dispatchId } = await startSettledWorker()
    db.db
      .prepare("UPDATE worker_dispatches SET state = 'stopped' WHERE dispatch_id = ?")
      .run(dispatchId)
    goneAfterSettle()

    const release = call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() => expect(proving).toHaveBeenCalled())
    const { dispatchId: successor } = await transferWhileProving(dispatchId)
    const resourceId = db.getWorkerTerminalResourceByOwner(successor)!.id
    db.storeWorkerTerminalArchiveBeforeStop({
      dispatchId: successor,
      resourceId,
      kind: 'transcript_pin',
      content: '{"version":3,"agent":"claude","sessionId":"successor-session"}',
      archiveSource: 'transcript',
      archiveStatus: 'captured'
    })
    const before = db.getWorkerTerminalResource(resourceId)
    const archive = db.getWorkerTerminalArchive(successor)
    listing.resolve({ processes: [], inProcessOwner: false })

    await expect(release).resolves.toMatchObject({
      dispatchId,
      state: 'retained',
      reason: 'ownership_transferred',
      archive: null
    })
    expect(db.getWorkerTerminalResource(resourceId)).toEqual(before)
    expect(db.getWorkerTerminalArchive(successor)).toEqual(archive)
  })

  it.each(['leads', 'joins'] as const)(
    'charges no recovery attempt to the successor when recovery %s a release that lost custody',
    async (role) => {
      setup()
      const listing = deferred<{ processes: PtyProcessInfo[]; inProcessOwner: boolean }>()
      const proving = vi.fn(() => listing.promise)
      loseWorkerTerminal(proving)
      const { dispatchId } = await startSettledWorker()
      goneAfterSettle()
      let release: Promise<unknown> | null = null
      if (role === 'joins') {
        release = call('orchestration.workerRelease', { dispatch: dispatchId })
      } else {
        expect(db.requestWorkerTerminalRelease(dispatchId).disposition).toBe('requested')
      }
      const recovery = reconcileRequestedWorkerTerminalReleases(runtime)
      await vi.waitFor(() => expect(proving).toHaveBeenCalledTimes(1))
      const { dispatchId: successor } = await transferWhileProving(dispatchId)
      const before = db.getWorkerTerminalResourceByOwner(successor)
      expect(before?.recovery_attempt_count).toBe(0)
      listing.resolve({ processes: [], inProcessOwner: false })

      await recovery
      await release
      expect(db.getWorkerTerminalResourceByOwner(successor)).toEqual(before)
    }
  )

  it("still counts recovery's attempt on its own worker's row", async () => {
    setup()
    const alive = [{ id: 'pty-worker', incarnationId: workerGeneration, cwd: '', title: '' }]
    loseWorkerTerminal(async () => ({ processes: alive, inProcessOwner: false }))
    const { dispatchId } = await startSettledWorker()
    expect(db.requestWorkerTerminalRelease(dispatchId).disposition).toBe('requested')
    goneAfterSettle()

    await expect(reconcileRequestedWorkerTerminalReleases(runtime)).resolves.toMatchObject({
      pending: 1
    })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.recovery_attempt_count).toBe(1)
  })

  it("never lets a sweep's stale item release the row a successor took over meanwhile", async () => {
    setup()
    const listing = deferred<{ processes: PtyProcessInfo[]; inProcessOwner: boolean }>()
    const proving = vi.fn(() => listing.promise)
    loseWorkerTerminal(proving)
    const { dispatchId } = await startSettledWorker()
    db.db
      .prepare("UPDATE worker_dispatches SET state = 'stopped' WHERE dispatch_id = ?")
      .run(dispatchId)
    db.db
      .prepare(
        "UPDATE worker_terminal_resources SET updated_at = datetime('now', '-1 minute') WHERE owner_dispatch_id = ?"
      )
      .run(dispatchId)
    goneAfterSettle()

    // The sweep stages the predecessor, then waits on its census.
    const sweep = sweepStoppedWorkerTerminals(runtime, () => false)
    await vi.waitFor(() => expect(proving).toHaveBeenCalledTimes(1))
    const { taskId, dispatchId: successor } = await reuseTerminal()
    db.settleWorkerReport({ taskId, dispatchId: successor, outcome: 'succeeded', result: 'done' })
    const resourceId = db.getWorkerTerminalResourceByOwner(successor)!.id
    db.storeWorkerTerminalArchiveBeforeStop({
      dispatchId: successor,
      resourceId,
      kind: 'terminal_tail',
      content: '{"version":3,"fallbackReason":"session_not_reported"}',
      archiveSource: 'terminal',
      archiveStatus: 'unavailable'
    })
    const before = db.getWorkerTerminalResource(resourceId)
    const archive = db.getWorkerTerminalArchive(successor)
    listing.resolve({ processes: [], inProcessOwner: false })
    await sweep

    expect(db.getWorkerTerminalResource(resourceId)).toEqual(before)
    expect(db.getWorkerTerminalArchive(successor)).toEqual(archive)
    // The successor's own release still proves its exit and settles, as its own.
    await expect(
      call('orchestration.workerRelease', { dispatch: successor })
    ).resolves.toMatchObject({ dispatchId: successor, state: 'released' })
    expect(db.getWorkerTerminalResource(resourceId)?.release_state).toBe('released')
  })

  it("settles a sweep's batch item only for the dispatch that owns the row now", async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    const { taskId, dispatchId: successor } = await reuseTerminal()
    db.settleWorkerReport({ taskId, dispatchId: successor, outcome: 'succeeded', result: 'done' })
    const resourceId = db.getWorkerTerminalResourceByOwner(successor)!.id
    db.storeWorkerTerminalArchiveBeforeStop({
      dispatchId: successor,
      resourceId,
      kind: 'terminal_tail',
      content: '{"version":3,"fallbackReason":"session_not_reported"}',
      archiveSource: 'terminal',
      archiveStatus: 'unavailable'
    })
    const before = db.getWorkerTerminalResource(resourceId)!
    const staged = {
      resourceId,
      processIncarnation: workerIncarnation,
      hostScope: before.host_scope
    }

    expect(
      db.settleDeadWorkerTerminalReleases([{ ...staged, requestingDispatchId: dispatchId }])
    ).toBe(0)
    expect(db.getWorkerTerminalResource(resourceId)).toEqual(before)
    expect(
      db.settleDeadWorkerTerminalReleases([{ ...staged, requestingDispatchId: successor }])
    ).toBe(1)
  })
})
