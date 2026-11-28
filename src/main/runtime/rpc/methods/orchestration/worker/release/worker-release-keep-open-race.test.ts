import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import '../../../../../orchestration/db/contract-constants'
import '../../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../../orchestration/db/dispatch-row-writer'
import '../../../../../orchestration/db/attempt-outcome-projection'
import { bindWorkerTerminal } from '../../../../../orchestration/db/worker-terminal/worker-bound-terminals'
import type { CrewInvalidation } from '../../../../../orchestration/crew/crew-changes'
import {
  createWorkerReleaseFixture,
  deferred,
  type WorkerReleaseFixture
} from './worker-release.test-fixture'

const devPaneKey = 'tab_dev:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
type Ingress = 'stop' | 'abandon' | 'kept_by_older_build'

describe("a keep-open during a stopped or abandoned worker's exit proof", () => {
  let fixture: WorkerReleaseFixture
  let db: OrchestrationDb
  let unsubscribe: (() => void) | undefined
  const crewNotices: CrewInvalidation[] = []

  afterEach(() => {
    unsubscribe?.()
    unsubscribe = undefined
    crewNotices.length = 0
    db.close()
    vi.restoreAllMocks()
  })

  const rowOf = (id: string) =>
    db.db.prepare('SELECT * FROM worker_terminal_resources WHERE id = ?').get(id)
  const archiveOf = (dispatchId: string) =>
    db.db.prepare('SELECT * FROM worker_terminal_archives WHERE dispatch_id = ?').get(dispatchId)
  const bindingsOf = (origin: string) =>
    db.db
      .prepare(
        'SELECT * FROM worker_bound_terminals WHERE dispatch_id = ? ORDER BY terminal_handle'
      )
      .all(origin)
  // Raw SQL, null where the table is absent, so this file also runs against a build without revisions.
  const hasRevisions = () =>
    db.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'worker_terminal_release_attempts'"
      )
      .get() !== undefined
  const revisionRows = (id: string) =>
    hasRevisions()
      ? db.db
          .prepare('SELECT attempt FROM worker_terminal_release_attempts WHERE resource_id = ?')
          .all(id)
      : []
  const revisionOf = (id: string): number | null =>
    hasRevisions() ? Number(revisionRows(id)[0]?.attempt ?? 0) : null
  const statusNotices = (dispatchId: string) =>
    vi
      .mocked(fixture.runtime.notifyMessageArrived)
      .mock.calls.filter(
        ([target, kind]) => target === `dispatch:${dispatchId}` && kind === 'status'
      ).length
  // The old CAS inputs, plus the incarnation the settle checks on its own.
  const casInputs = (id: string) =>
    db.db
      .prepare(
        `SELECT owner_dispatch_id, host_scope, release_state, retained_reason, process_incarnation
           FROM worker_terminal_resources WHERE id = ?`
      )
      .get(id)

  /** A worker whose own terminal is retained/user_requested by `ingress`, with a created terminal still bound. */
  async function retainedWorker(ingress: Ingress) {
    fixture = createWorkerReleaseFixture()
    db = fixture.db
    const { runtime, call } = fixture
    const original = vi.mocked(runtime.getTerminalPaneKey).getMockImplementation()!
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_dev' ? devPaneKey : original(handle)
    )
    const { dispatchId } = await (ingress === 'kept_by_older_build'
      ? fixture.startSettledWorker()
      : fixture.startWorker())
    const resource = db.getWorkerTerminalResourceByOwner(dispatchId)!
    const bindDev = () =>
      bindWorkerTerminal(db, {
        dispatchId: resource.origin_dispatch_id,
        terminalHandle: 'term_dev',
        paneKey: devPaneKey,
        role: 'created'
      })
    if (ingress === 'stop') {
      await expect(
        call('orchestration.workerRetain', { dispatch: dispatchId })
      ).resolves.toMatchObject({
        state: 'retained',
        reason: 'user_requested'
      })
      await call('orchestration.workerStop', { dispatch: dispatchId })
      expect(db.getWorkerDispatch(dispatchId)?.state).toBe('stopped')
      // Compatibility fixture: Stop's own cleanup closed the bindings it had.
      bindDev()
    } else if (ingress === 'abandon') {
      // A real binding, which Abandon leaves in place.
      bindDev()
      await call('orchestration.workerAbandon', { dispatch: dispatchId })
      expect(db.getWorkerDispatch(dispatchId)?.state).toBe('abandoned')
    } else {
      // Kept open and stopped by a build without revisions: the same state, and no revision row.
      db.db
        .prepare("UPDATE worker_dispatches SET state = 'stopped' WHERE dispatch_id = ?")
        .run(dispatchId)
      db.db
        .prepare(
          `UPDATE worker_terminal_resources SET release_state = 'retained',
             retained_reason = 'user_requested', auto_release_at = NULL WHERE id = ?`
        )
        .run(resource.id)
      bindDev()
    }
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      ownership_state: 'owned',
      release_state: 'retained',
      retained_reason: 'user_requested'
    })
    const listing = deferred<{ processes: never[]; inProcessOwner: boolean }>()
    const proving = vi.fn(() => listing.promise)
    fixture.loseWorkerTerminal(proving)
    fixture.goneAfterSettle()
    vi.mocked(runtime.closeTerminal).mockClear()
    unsubscribe = db.crewChanges.subscribe((facets) => crewNotices.push(facets))
    return {
      dispatchId,
      resourceId: resource.id,
      origin: resource.origin_dispatch_id,
      admittedRevision: revisionOf(resource.id),
      proving,
      exited: () => listing.resolve({ processes: [], inProcessOwner: false })
    }
  }

  for (const ingress of ['stop', 'abandon', 'kept_by_older_build'] as const) {
    it(`${ingress}: the keep-open wins; nothing is released, closed or announced`, async () => {
      const worker = await retainedWorker(ingress)
      const { call, runtime } = fixture
      const { dispatchId, resourceId } = worker
      if (ingress === 'kept_by_older_build') {
        expect(revisionRows(resourceId)).toEqual([])
      }

      const release = call('orchestration.workerRelease', { dispatch: dispatchId })
      await vi.waitFor(() => expect(worker.proving).toHaveBeenCalled())
      const admitted = { cas: casInputs(resourceId), row: rowOf(resourceId) }
      await expect(
        call('orchestration.workerRetain', { dispatch: dispatchId })
      ).resolves.toMatchObject({
        state: 'retained',
        reason: 'user_requested'
      })
      // Both writes land in the same second: only the revision tells them apart.
      db.db
        .prepare('UPDATE worker_terminal_resources SET updated_at = ? WHERE id = ?')
        .run(admitted.row!.updated_at, resourceId)
      expect(casInputs(resourceId)).toEqual(admitted.cas)
      expect(rowOf(resourceId)).toEqual(admitted.row)
      const kept = {
        row: rowOf(resourceId),
        archive: archiveOf(dispatchId) ?? null,
        bindings: bindingsOf(worker.origin)
      }
      expect(kept.bindings).toHaveLength(1)
      const statusBefore = statusNotices(dispatchId)
      crewNotices.length = 0

      worker.exited()
      const receipt = await release

      expect(receipt).toMatchObject({
        state: 'retained',
        reason: 'user_requested',
        processAction: 'none'
      })
      expect({
        row: rowOf(resourceId),
        archive: archiveOf(dispatchId) ?? null,
        bindings: bindingsOf(worker.origin)
      }).toEqual(kept)
      expect(vi.mocked(runtime.closeTerminal)).not.toHaveBeenCalled()
      expect(statusNotices(dispatchId)).toBe(statusBefore)
      expect(crewNotices).toEqual([])
      expect(worker.admittedRevision).toBe(ingress === 'kept_by_older_build' ? 0 : 1)
      expect(revisionOf(resourceId)).toBe(worker.admittedRevision! + 1)
    })
  }

  for (const ingress of ['stop', 'abandon'] as const) {
    it(`${ingress}: a release settling first wins, and a later keep-open answers already released`, async () => {
      const worker = await retainedWorker(ingress)
      const { call, runtime } = fixture
      const { dispatchId, resourceId } = worker
      const release = call('orchestration.workerRelease', { dispatch: dispatchId })
      await vi.waitFor(() => expect(worker.proving).toHaveBeenCalled())
      const statusBefore = statusNotices(dispatchId)

      worker.exited()

      await expect(release).resolves.toMatchObject({ state: 'released', processAction: 'none' })
      expect(db.getWorkerTerminalResource(resourceId)).toMatchObject({
        ownership_state: 'released',
        release_state: 'released'
      })
      expect(vi.mocked(runtime.closeTerminal)).toHaveBeenCalledWith('term_dev')
      expect(statusNotices(dispatchId)).toBe(statusBefore + 1)
      expect(crewNotices.some((facets) => facets.has('topology'))).toBe(true)
      await expect(
        call('orchestration.workerRetain', { dispatch: dispatchId })
      ).resolves.toMatchObject({
        state: 'already_released'
      })
      expect(revisionOf(resourceId)).toBe(worker.admittedRevision)
    })
  }

  it('a keep-open before the release is already part of what the release settles', async () => {
    const worker = await retainedWorker('abandon')
    const { call } = fixture
    await call('orchestration.workerRetain', { dispatch: worker.dispatchId })
    const release = call('orchestration.workerRelease', { dispatch: worker.dispatchId })
    await vi.waitFor(() => expect(worker.proving).toHaveBeenCalled())
    worker.exited()

    await expect(release).resolves.toMatchObject({ state: 'released' })
    expect(db.getWorkerTerminalResource(worker.resourceId)?.release_state).toBe('released')
  })

  it('an unchanged row whose exit stays unproven keeps identity_unproven', async () => {
    fixture = createWorkerReleaseFixture()
    db = fixture.db
    const { call } = fixture
    const { dispatchId } = await fixture.startWorker()
    await call('orchestration.workerAbandon', { dispatch: dispatchId })
    fixture.loseWorkerTerminal(async () => ({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the exit proof reads only id and incarnation.
      processes: [
        {
          id: 'pty-worker',
          incarnationId: '11111111-1111-4111-8111-111111111111',
          cwd: '',
          title: ''
        }
      ] as never[],
      inProcessOwner: false
    }))
    fixture.goneAfterSettle()

    await expect(
      call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({
      state: 'retained',
      reason: 'identity_unproven'
    })
  })

  it('a requested release of a worker kept open earlier ignores the revision, even one that moves during its proof', async () => {
    fixture = createWorkerReleaseFixture()
    db = fixture.db
    const { call } = fixture
    const listing = deferred<{ processes: never[]; inProcessOwner: boolean }>()
    const proving = vi.fn(() => listing.promise)
    fixture.loseWorkerTerminal(proving)
    const { dispatchId } = await fixture.startSettledWorker()
    const resourceId = db.getWorkerTerminalResourceByOwner(dispatchId)!.id
    await expect(
      call('orchestration.workerRetain', { dispatch: dispatchId })
    ).resolves.toMatchObject({
      state: 'retained',
      reason: 'user_requested'
    })
    expect(revisionOf(resourceId)).toBe(1)
    fixture.saveSession(resourceId, 'claude-session-a')
    fixture.goneAfterSettle()

    const release = call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() =>
      expect(db.getWorkerTerminalResource(resourceId)?.release_state).toBe('requested')
    )
    await vi.waitFor(() => expect(proving).toHaveBeenCalled())
    // Only the stored revision moves: a requested release that compared any revision would refuse.
    db.db
      .prepare(
        'UPDATE worker_terminal_release_attempts SET attempt = attempt + 1 WHERE resource_id = ?'
      )
      .run(resourceId)
    const transcriptPath = fixture.saveSession(resourceId, 'claude-session-b')
    listing.resolve({ processes: [], inProcessOwner: false })

    await expect(release).resolves.toMatchObject({
      state: 'released',
      processAction: 'none',
      archive: { source: 'transcript', status: 'captured' }
    })
    expect(db.getWorkerTerminalResource(resourceId)).toMatchObject({
      ownership_state: 'released',
      release_state: 'released'
    })
    expect(JSON.parse(db.getWorkerTerminalArchive(dispatchId)!.content)).toMatchObject({
      sessionId: 'claude-session-b',
      transcriptPath
    })
    expect(revisionOf(resourceId)).toBe(2)
  })

  it('a real Stop of a never-kept worker settles its own terminal and writes no revision', async () => {
    fixture = createWorkerReleaseFixture()
    db = fixture.db
    const { dispatchId } = await fixture.startWorker()
    const resourceId = db.getWorkerTerminalResourceByOwner(dispatchId)!.id
    expect(db.getWorkerTerminalResource(resourceId)?.release_state).toBe('not_requested')
    // Stop proves the process gone before it settles.
    fixture.loseWorkerTerminal(async () => ({ processes: [], inProcessOwner: false }))

    await fixture.call('orchestration.workerStop', { dispatch: dispatchId })

    expect(db.getWorkerDispatch(dispatchId)?.state).toBe('stopped')
    expect(db.getWorkerTerminalResource(resourceId)).toMatchObject({
      ownership_state: 'released',
      release_state: 'released'
    })
    expect(revisionRows(resourceId)).toEqual([])
    expect(hasRevisions()).toBe(true)
  })
})
