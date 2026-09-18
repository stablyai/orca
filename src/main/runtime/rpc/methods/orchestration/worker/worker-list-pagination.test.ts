import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../../../../../sqlite/sync-database'
import { OrchestrationDb } from '../../../../orchestration/db'
import { WORKER_LIST_CURSOR_EXPIRED_MESSAGE } from '../../../../orchestration/db/worker-terminal/worker-terminal-listing'
import type { FederatedDispatchRow } from '../../../../orchestration/types'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { decodeWorkerListCursor, encodeWorkerListCursor } from './worker-list-cursor'
import { ORCHESTRATION_WORKER_LIST_METHOD } from './worker-list-method'

type WorkerListResult = {
  workers: {
    dispatchId: string
    projection: { attention: { categories: string[] } }
  }[]
  counts: Record<string, number>
  page: { total: number; hasMore: boolean; nextCursor: string | null }
}

describe('orchestration worker-list pagination', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('returns a complete filtered legacy result while current clients page above 100 rows', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Mixed-version worker inventory',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    for (let index = 0; index < 125; index += 1) {
      insertDispatch(db, run.id, `dispatch-${String(index).padStart(3, '0')}`)
    }

    const legacy = await callWorkerList(runtime, {
      run: run.id,
      terminalState: 'retained'
    })
    expect(legacy.workers).toHaveLength(125)
    expect(legacy.page).toEqual({ total: 125, limit: 5_000, hasMore: false, nextCursor: null })

    const first = await callWorkerList(runtime, {
      run: run.id,
      terminalState: 'retained',
      paginate: true
    })
    expect(first.workers.map((worker) => worker.dispatchId)).toEqual(
      Array.from({ length: 100 }, (_, index) => `dispatch-${String(124 - index).padStart(3, '0')}`)
    )
    expect(first.page).toMatchObject({ total: 125, hasMore: true })
    expect(first.page.nextCursor).toEqual(expect.any(String))
    expect(first.page.nextCursor).not.toBe('dispatch-099')

    const second = await callWorkerList(runtime, {
      run: run.id,
      terminalState: 'retained',
      paginate: true,
      cursor: first.page.nextCursor
    })
    expect(second.workers.map((worker) => worker.dispatchId)).toEqual(
      Array.from({ length: 25 }, (_, index) => `dispatch-${String(24 - index).padStart(3, '0')}`)
    )
    expect(second.page).toEqual({ total: 125, limit: 100, hasMore: false, nextCursor: null })
  })

  it('fails an omitted-pagination legacy result above the explicit safety ceiling', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(db, 'listWorkerTerminalResources').mockReturnValue(
      Array.from({ length: 5_001 }, () => null) as never
    )

    await expect(callWorkerList(runtime, {})).rejects.toMatchObject({
      code: 'worker_list_snapshot_too_large',
      message: expect.stringContaining('at most 5000 rows')
    })
  })

  it('excludes later same-second rows that sort between snapshot cursors', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Stable worker inventory',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    insertDispatch(db, run.id, 'dispatch-a')
    insertDispatch(db, run.id, 'dispatch-z')

    const first = await callWorkerList(runtime, { run: run.id, limit: 1 })
    expect(first.workers.map((worker) => worker.dispatchId)).toEqual(['dispatch-z'])
    expect(first.page).toMatchObject({ total: 2, hasMore: true })
    expect(first.page.nextCursor).toEqual(expect.any(String))

    insertDispatch(db, run.id, 'dispatch-m')

    const second = await callWorkerList(runtime, {
      run: run.id,
      limit: 1,
      cursor: first.page.nextCursor
    })
    expect(second.workers.map((worker) => worker.dispatchId)).toEqual(['dispatch-a'])
    expect(second.page).toEqual({ total: 2, limit: 1, hasMore: false, nextCursor: null })
  })

  it('puts the two newest dispatches on the first page and walks the cursor toward the oldest', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Newest-first worker inventory',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    insertDispatch(db, run.id, 'dispatch-oldest')
    insertDispatch(db, run.id, 'dispatch-middle')
    insertDispatch(db, run.id, 'dispatch-newest')

    const first = await callWorkerList(runtime, { run: run.id, limit: 2 })
    expect(first.workers.map((worker) => worker.dispatchId)).toEqual([
      'dispatch-newest',
      'dispatch-middle'
    ])
    expect(first.page).toMatchObject({ total: 3, hasMore: true })
    expect(decodeWorkerListCursor(first.page.nextCursor ?? '')?.version).toBe(4)

    insertDispatch(db, run.id, 'dispatch-after-snapshot')

    const second = await callWorkerList(runtime, {
      run: run.id,
      limit: 2,
      cursor: first.page.nextCursor
    })
    expect(second.workers.map((worker) => worker.dispatchId)).toEqual(['dispatch-oldest'])
    expect(second.page).toEqual({ total: 3, limit: 2, hasMore: false, nextCursor: null })
  })

  it('expires a version-one snapshot cursor from an older runtime', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Compatible worker inventory',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    insertDispatch(db, run.id, 'dispatch-a')
    insertDispatch(db, run.id, 'dispatch-z')
    const cursor = encodeWorkerListCursor({
      version: 1,
      snapshot: { createdAt: '2026-08-27 00:00:00', dispatchId: 'dispatch-z' },
      after: { createdAt: '2026-08-27 00:00:00', dispatchId: 'dispatch-z' }
    })

    await expect(callWorkerList(runtime, { run: run.id, limit: 1, cursor })).rejects.toMatchObject({
      code: 'worker_list_cursor_expired',
      message: WORKER_LIST_CURSOR_EXPIRED_MESSAGE
    })
  })

  it('expires an old v2 cursor instead of returning already-seen older rows', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Ascending cursor',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    insertDispatch(db, run.id, 'dispatch-oldest')
    insertDispatch(db, run.id, 'dispatch-middle')
    insertDispatch(db, run.id, 'dispatch-newest')
    // An ascending-era first page of 2 was [oldest, middle] and minted after=middle.
    // Reinterpreting that cursor as descending would return [oldest] (already seen)
    // with hasMore: false, silently dropping newest.
    const cursor = encodeWorkerListCursor({
      version: 2,
      snapshot: { databaseId: 3 },
      after: { createdAt: '2026-08-27 00:00:00', dispatchId: 'dispatch-middle' }
    })

    await expect(callWorkerList(runtime, { run: run.id, limit: 2, cursor })).rejects.toMatchObject({
      code: 'worker_list_cursor_expired',
      message: WORKER_LIST_CURSOR_EXPIRED_MESSAGE
    })
  })

  it('expires a non-JSON bare dispatch-id cursor instead of paging older rows', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Bare dispatch cursor',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    insertDispatch(db, run.id, 'dispatch-oldest')
    insertDispatch(db, run.id, 'dispatch-middle')
    insertDispatch(db, run.id, 'dispatch-newest')

    await expect(
      callWorkerList(runtime, { run: run.id, limit: 2, cursor: 'dispatch-newest' })
    ).rejects.toMatchObject({
      code: 'worker_list_cursor_expired',
      message: WORKER_LIST_CURSOR_EXPIRED_MESSAGE
    })
  })

  it('expires a v4 cursor that omits after.databaseId', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'v4 without rowid',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    insertDispatch(db, run.id, 'dispatch-oldest')
    insertDispatch(db, run.id, 'dispatch-middle')
    insertDispatch(db, run.id, 'dispatch-newest')
    const cursor = Buffer.from(
      JSON.stringify({
        version: 4,
        snapshot: { databaseId: 3 },
        after: { createdAt: '2026-08-27 00:00:00', dispatchId: 'dispatch-newest' }
      }),
      'utf8'
    ).toString('base64url')

    await expect(callWorkerList(runtime, { run: run.id, limit: 2, cursor })).rejects.toMatchObject({
      code: 'worker_list_cursor_expired',
      message: WORKER_LIST_CURSOR_EXPIRED_MESSAGE
    })
  })

  it('expires a pre-rowid cursor whose anchor row a reset deleted', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Old cursor',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    insertDispatch(db, run.id, 'dispatch-a')
    insertDispatch(db, run.id, 'dispatch-m')
    insertDispatch(db, run.id, 'dispatch-z')
    const cursor = encodeWorkerListCursor({
      version: 4,
      snapshot: { databaseId: 3 },
      after: { createdAt: '2026-08-27 00:00:00', dispatchId: 'dispatch-z', databaseId: 3 }
    })
    const ok = await callWorkerList(runtime, { run: run.id, limit: 10, cursor })
    expect(ok.workers.map((worker) => worker.dispatchId)).toEqual(['dispatch-m', 'dispatch-a'])

    sqliteFor(db).prepare('DELETE FROM dispatch_contexts WHERE id = ?').run('dispatch-z')

    // `rowid < NULL` used to exclude every row: zero workers against a non-zero total.
    await expect(callWorkerList(runtime, { run: run.id, limit: 10, cursor })).rejects.toMatchObject(
      {
        code: 'worker_list_cursor_expired'
      }
    )
  })

  it('keeps filtered snapshot membership when a later worker changes state', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Stable filtered inventory',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    insertDispatch(db, run.id, 'dispatch-a')
    insertDispatch(db, run.id, 'dispatch-z')

    const first = await callWorkerList(runtime, {
      run: run.id,
      terminalState: 'retained',
      limit: 1
    })
    expect(first.workers.map((worker) => worker.dispatchId)).toEqual(['dispatch-z'])
    expect(first.page).toMatchObject({ total: 2, hasMore: true })

    sqliteFor(db)
      .prepare('UPDATE dispatch_contexts SET assignee_handle = NULL WHERE id = ?')
      .run('dispatch-a')
    const second = await callWorkerList(runtime, {
      run: run.id,
      terminalState: 'retained',
      limit: 1,
      cursor: first.page.nextCursor
    })

    expect(second.workers.map((worker) => worker.dispatchId)).toEqual(['dispatch-a'])
    expect(second.page).toEqual({ total: 2, limit: 1, hasMore: false, nextCursor: null })
    // The pinned total and the counts have to describe the same rows.
    expect(second.counts).toEqual({ retained: second.page.total })
  })

  it('keeps an include-remote filtered page pinned across 32 concurrent snapshot allocations', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Pinned filtered inventory',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    insertDispatch(db, run.id, 'dispatch-a')
    insertDispatch(db, run.id, 'dispatch-z')
    vi.spyOn(db, 'listFederatedDispatchesByIds').mockImplementation((dispatchIds) =>
      dispatchIds.includes('dispatch-z') ? [federatedDispatch('dispatch-z')] : []
    )
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment-remote',
      name: 'remote',
      peerFingerprint: 'peer-remote',
      pairingRevision: 1
    })
    let resolveSnapshot!: () => void
    const snapshotGate = new Promise<void>((resolve) => {
      resolveSnapshot = resolve
    })
    const remoteCall = vi
      .spyOn(runtime, 'callOrchestrationWorkerServer')
      .mockImplementation(async () => {
        await snapshotGate
        return {
          runtimeEpoch: 'epoch-remote',
          items: [
            {
              dispatchId: 'dispatch-z',
              observation: { status: 'live', exactWorker: true }
            }
          ]
        }
      })

    const pending = callWorkerList(runtime, {
      run: run.id,
      terminalState: 'retained',
      includeRemote: true,
      limit: 1
    })
    await vi.waitFor(() =>
      expect(remoteCall).toHaveBeenCalledWith(
        'environment-remote',
        'orchestration.federationFleetSnapshot',
        { dispatchIds: ['dispatch-z'] },
        expect.any(Number),
        undefined,
        { expectedEnvironmentPairingRevision: 1 }
      )
    )
    for (let call = 0; call < 32; call += 1) {
      await callWorkerList(runtime, { run: run.id, terminalState: 'retained', limit: 1 })
    }
    resolveSnapshot()

    const first = await pending
    expect(first).toMatchObject({
      workers: [{ dispatchId: 'dispatch-z' }],
      page: { total: 2, hasMore: true, nextCursor: expect.any(String) }
    })
    const second = await callWorkerList(runtime, {
      run: run.id,
      terminalState: 'retained',
      limit: 1,
      cursor: first.page.nextCursor
    })
    expect(second.workers.map((worker) => worker.dispatchId)).toEqual(['dispatch-a'])
  })

  it('does not allocate filtered snapshots when the first page has no more rows', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Snapshot-free terminal page',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    insertDispatch(db, run.id, 'dispatch-a')
    insertDispatch(db, run.id, 'dispatch-z')
    const first = await callWorkerList(runtime, {
      run: run.id,
      terminalState: 'retained',
      limit: 1
    })

    for (let call = 0; call < 32; call += 1) {
      const terminalPage = await callWorkerList(runtime, {
        run: run.id,
        terminalState: 'released',
        limit: 1
      })
      expect(terminalPage.page).toMatchObject({ total: 0, hasMore: false, nextCursor: null })
    }
    const second = await callWorkerList(runtime, {
      run: run.id,
      terminalState: 'retained',
      limit: 1,
      cursor: first.page.nextCursor
    })

    expect(second.workers.map((worker) => worker.dispatchId)).toEqual(['dispatch-a'])
  })

  it('projects a 100-row page within six synchronous read statements', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Bounded worker inventory reads',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    for (let index = 0; index < 100; index += 1) {
      insertDispatch(db, run.id, `dispatch-${String(index).padStart(3, '0')}`)
    }
    db.recordAttemptObservation({
      id: 'observation-failed-worker',
      dispatchId: 'dispatch-050',
      sequence: 0,
      authorityId: 'home',
      authorityClock: 'home',
      facet: 'worker_report',
      payload: { status: 'accepted', outcome: 'failed' },
      homeReceivedAt: Date.now()
    })
    const prepare = vi.spyOn(sqliteFor(db), 'prepare')
    prepare.mockClear()

    const page = await callWorkerList(runtime, { run: run.id, limit: 100 })

    expect(page.workers.map((worker) => worker.dispatchId)).toEqual(
      Array.from({ length: 100 }, (_, index) => `dispatch-${String(99 - index).padStart(3, '0')}`)
    )
    expect(
      page.workers.find((worker) => worker.dispatchId === 'dispatch-050')?.projection.attention
        .categories
    ).toContain('failure')
    expect(page.page).toEqual({ total: 100, limit: 100, hasMore: false, nextCursor: null })
    expect(prepare).toHaveBeenCalledTimes(6)
  })

  it('aggregates exact inventory counts while preserving filtered totals', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Exact worker inventory counts',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    insertWorkerInventory(db, run.id, 'active', 'ready', 'not_requested')
    insertWorkerInventory(db, run.id, 'reclaimable-a', 'succeeded', 'not_requested')
    insertWorkerInventory(db, run.id, 'reclaimable-b', 'failed', 'not_requested')
    insertDispatch(db, run.id, 'retained')
    insertWorkerInventory(db, run.id, 'released', 'succeeded', 'released', 'released')
    insertWorkerInventory(db, run.id, 'release-pending', 'ready', 'requested')
    insertWorkerInventory(db, run.id, 'release-unknown', 'ready', 'unknown')

    const page = await callWorkerList(runtime, { run: run.id })
    const filtered = await callWorkerList(runtime, {
      run: run.id,
      terminalState: 'reclaimable'
    })

    expect(page.counts).toEqual({
      active: 1,
      reclaimable: 2,
      retained: 1,
      release_pending: 1,
      release_unknown: 1,
      released: 1
    })
    expect(page.page.total).toBe(7)
    expect(filtered.workers.map((worker) => worker.dispatchId)).toEqual([
      'reclaimable-b',
      'reclaimable-a'
    ])
    expect(filtered.page.total).toBe(2)
    expect(filtered.counts).toEqual(page.counts)
  })

  it('never re-emits a row whose worker registers between pages', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Stable order key',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    insertDispatch(db, run.id, 'dispatch-a')
    insertDispatch(db, run.id, 'dispatch-z')

    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 5; page += 1) {
      const result: WorkerListResult = await callWorkerList(runtime, {
        run: run.id,
        limit: 1,
        ...(cursor ? { cursor } : {})
      })
      seen.push(...result.workers.map((worker) => worker.dispatchId))
      if (page === 0) {
        // A worker row lands for the first-page row; its COALESCE(created_at) sort key moves forward.
        sqliteFor(db)
          .prepare(
            `INSERT INTO worker_dispatches (dispatch_id, state, stage, agent_terminal_handle, created_at)
             VALUES (?, 'ready', 'ready', ?, '2026-08-27 01:00:00')`
          )
          .run('dispatch-z', 'term-dispatch-z')
      }
      cursor = result.page.nextCursor
      if (!cursor) {
        break
      }
    }

    expect(seen).toEqual(['dispatch-z', 'dispatch-a'])
  })

  it('counts only the rows a pinned filtered cursor can still reach', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Pinned filtered counts',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    insertDispatch(db, run.id, 'dispatch-a')
    insertDispatch(db, run.id, 'dispatch-z')

    const first = await callWorkerList(runtime, {
      run: run.id,
      terminalState: 'retained',
      limit: 1
    })
    expect(first.page).toMatchObject({ total: 2, hasMore: true })
    expect(first.counts).toEqual({ retained: 2 })

    insertDispatch(db, run.id, 'dispatch-m')
    const second = await callWorkerList(runtime, {
      run: run.id,
      terminalState: 'retained',
      limit: 1,
      cursor: first.page.nextCursor
    })

    expect(second.workers.map((worker) => worker.dispatchId)).toEqual(['dispatch-a'])
    expect(second.page.total).toBe(2)
    expect(second.counts).toEqual({ retained: 2 })
  })

  it.each([10, 20, 40])(
    'reads %i unreachable federated rows without a per-row query',
    async (workerCount) => {
      db = new OrchestrationDb(':memory:')
      const runtime = new OrcaRuntimeService()
      runtime.setOrchestrationDb(db)
      const run = db.createRun({
        objective: 'Federated read cost',
        coordinatorHandle: 'term-coordinator',
        coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      })
      for (let index = 0; index < workerCount; index += 1) {
        insertDispatch(db, run.id, `dispatch-${String(index).padStart(3, '0')}`)
      }
      const prepare = vi.spyOn(sqliteFor(db), 'prepare')
      prepare.mockClear()

      await callWorkerList(runtime, { run: run.id, limit: 100, includeRemote: true })

      // The page cost must not grow with the number of federated rows on it.
      expect(prepare.mock.calls.length).toBeLessThan(8)
    }
  )

  it('filters and labels terminal state through one projection', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Unsupervised owned resource',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    // An owned, unreleased resource whose dispatch has no worker_dispatches row.
    insertDispatch(db, run.id, 'dispatch-unsupervised')
    sqliteFor(db)
      .prepare(
        `INSERT INTO worker_terminal_resources (
           id, origin_dispatch_id, owner_dispatch_id, terminal_handle,
           ownership_state, release_state
         ) VALUES (?, ?, ?, ?, 'owned', 'not_requested')`
      )
      .run('resource-unsupervised', 'dispatch-unsupervised', 'dispatch-unsupervised', 'term-x')

    const all = await callWorkerList(runtime, { run: run.id })
    const active = await callWorkerList(runtime, { run: run.id, terminalState: 'active' })

    expect(all.counts).toEqual({ active: 1 })
    expect(active.workers.map((worker) => worker.dispatchId)).toEqual(['dispatch-unsupervised'])
    expect(active.page.total).toBe(1)
  })

  describe('a legacy cursor anchored outside the requested Run', () => {
    function twoRuns(): { runA: string; runB: string } {
      db = new OrchestrationDb(':memory:')
      const runA = db.createRun({
        objective: 'A',
        coordinatorHandle: 'term-a',
        coordinatorPaneKey: 'tab-a:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      })
      const runB = db.createRun({
        objective: 'B',
        coordinatorHandle: 'term-b',
        coordinatorPaneKey: 'tab-b:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      })
      insertDispatch(db, runA.id, 'a-1')
      insertDispatch(db, runA.id, 'a-2')
      insertDispatch(db, runB.id, 'b-1')
      insertDispatch(db, runB.id, 'b-2')
      return { runA: runA.id, runB: runB.id }
    }

    // Both shapes used to resolve to a rowid past Run A's rows and report a finished, empty page.
    it('expires a v4 cursor that must be resolved from a foreign anchor', async () => {
      const { runA } = twoRuns()
      const runtime = new OrcaRuntimeService()
      runtime.setOrchestrationDb(db!)
      // b-1's rowid so decode succeeds; resolveAnchorRowId still rejects the out-of-run anchor.
      const foreign = encodeWorkerListCursor({
        version: 4,
        snapshot: { databaseId: 4 },
        after: { createdAt: '2026-08-27 00:00:00', dispatchId: 'b-1', databaseId: 3 }
      })

      await expect(
        callWorkerList(runtime, { run: runA, limit: 10, cursor: foreign })
      ).rejects.toThrow(/changed destructively/u)
    })

    it('expires a v4 cursor that carries a foreign rowid', async () => {
      const { runA } = twoRuns()
      const runtime = new OrcaRuntimeService()
      runtime.setOrchestrationDb(db!)
      const foreign = encodeWorkerListCursor({
        version: 4,
        snapshot: { databaseId: 4 },
        after: { createdAt: '2026-08-27 00:00:00', dispatchId: 'b-1', databaseId: 3 }
      })

      await expect(
        callWorkerList(runtime, { run: runA, limit: 10, cursor: foreign })
      ).rejects.toThrow(/changed destructively/u)
    })

    it('still pages the requested Run from its own anchor', async () => {
      const { runA } = twoRuns()
      const runtime = new OrcaRuntimeService()
      runtime.setOrchestrationDb(db!)
      const own = encodeWorkerListCursor({
        version: 4,
        snapshot: { databaseId: 4 },
        after: { createdAt: '2026-08-27 00:00:00', dispatchId: 'a-2', databaseId: 2 }
      })

      const page = await callWorkerList(runtime, { run: runA, limit: 10, cursor: own })

      expect(page.workers.map((worker) => worker.dispatchId)).toEqual(['a-1'])
    })
  })
})

async function callWorkerList(
  runtime: OrcaRuntimeService,
  params: Record<string, unknown>
): Promise<WorkerListResult> {
  const parsed = ORCHESTRATION_WORKER_LIST_METHOD.params?.parse(params)
  return (await ORCHESTRATION_WORKER_LIST_METHOD.handler(parsed, { runtime })) as WorkerListResult
}

function insertDispatch(db: OrchestrationDb, runId: string, dispatchId: string): void {
  const task = db.createTask({ spec: dispatchId, runId })
  sqliteFor(db)
    .prepare(
      `INSERT INTO dispatch_contexts (
         id, run_id, task_id, assignee_handle, status, created_at
       ) VALUES (?, ?, ?, ?, 'dispatched', '2026-08-27 00:00:00')`
    )
    .run(dispatchId, runId, task.id, `term-${dispatchId}`)
}

function insertWorkerInventory(
  db: OrchestrationDb,
  runId: string,
  dispatchId: string,
  workerState: 'ready' | 'succeeded' | 'failed',
  releaseState: 'not_requested' | 'requested' | 'released' | 'unknown',
  ownershipState: 'owned' | 'released' = 'owned'
): void {
  insertDispatch(db, runId, dispatchId)
  const sqlite = sqliteFor(db)
  sqlite
    .prepare(
      `INSERT INTO worker_dispatches (
         dispatch_id, state, stage, agent_terminal_handle
       ) VALUES (?, ?, 'ready', ?)`
    )
    .run(dispatchId, workerState, `term-${dispatchId}`)
  sqlite
    .prepare(
      `INSERT INTO worker_terminal_resources (
         id, origin_dispatch_id, owner_dispatch_id, terminal_handle,
         ownership_state, release_state
       ) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      `resource-${dispatchId}`,
      dispatchId,
      dispatchId,
      `term-${dispatchId}`,
      ownershipState,
      releaseState
    )
}

function sqliteFor(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

function federatedDispatch(dispatchId: string): FederatedDispatchRow {
  return {
    dispatch_id: dispatchId,
    environment_id: 'environment-remote',
    environment_name: 'remote',
    peer_fingerprint: 'peer-remote',
    remote_runtime_epoch: 'epoch-remote',
    protocol_version: 3,
    remote_worktree_id: null,
    remote_terminal_handle: null,
    to_home_imported_sequence: 0,
    to_home_acknowledged_sequence: 0,
    created_at: '2026-08-27 00:00:00',
    updated_at: '2026-08-27 00:00:00'
  }
}
