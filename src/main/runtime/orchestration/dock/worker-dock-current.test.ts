import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../db/orchestration-db'
import { acknowledgeWorkerDock, readWorkerDock } from './worker-dock-read'
import { refreshWorkerDockActivity } from './worker-dock-activity'
import { subscribeWorkerDock, workerDockAgingDeadline } from './worker-dock-stream'

// The strip's current-work rule: live work always; failures only while recent, unacknowledged,
// not stopped by the owner and not replaced by a retry; unresolved or unverified rows age out.
const session = '22222222-2222-4222-8222-222222222222'
const party = `orca_session_id:${session}`
const NOW = Date.parse('2026-11-23T12:00:00Z')
const HOUR = 60 * 60_000
let db: OrchestrationDb
beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  db = new OrchestrationDb(':memory:')
})
afterEach(() => {
  db.close()
  vi.useRealTimers()
})

function task() {
  return db.createTask({ runId: 'run_legacy_local', spec: 'Verify journal writes' }).id
}
function dispatch(taskId = task()) {
  const { dispatch: created } = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 10,
    taskId,
    startOptions: { agent: 'codex' }
  })
  db.db
    .prepare('UPDATE dispatch_contexts SET creator_orca_session_id = ? WHERE id = ?')
    .run(session, created.id)
  return created.id
}
/** Moves a dispatch to a lifecycle state last changed `ago` ms before now. */
function settle(id: string, state: string, ago: number) {
  db.db
    .prepare('UPDATE worker_dispatches SET state = ?, updated_at = ? WHERE dispatch_id = ?')
    .run(state, new Date(NOW - ago).toISOString(), id)
}
const current = () =>
  readWorkerDock(db, { party, direction: 'around', currentOnly: true }).identities.map(
    (row) => row.dispatchId
  )
const settlementOf = (id: string) =>
  String(
    db.db.prepare('SELECT settlement FROM worker_dock_facts WHERE dispatch_id = ?').get(id)
      ?.settlement
  )

it('always shows live work, however old', () => {
  const starting = dispatch()
  const ready = dispatch()
  settle(ready, 'ready', 30 * 24 * HOUR)
  const stopping = dispatch()
  settle(stopping, 'stopping', 30 * 24 * HOUR)
  expect(new Set(current())).toEqual(new Set([starting, ready, stopping]))
})

it('shows a failure from the last four hours and drops an older one', () => {
  const recent = dispatch()
  settle(recent, 'failed', HOUR)
  const old = dispatch()
  settle(old, 'failed', 5 * HOUR)
  const stopped = dispatch()
  settle(stopped, 'abandoned', 2 * HOUR)
  expect(new Set(current())).toEqual(new Set([recent, stopped]))
})

it('drops an acknowledged failure', () => {
  const failed = dispatch()
  settle(failed, 'failed', HOUR)
  expect(current()).toEqual([failed])
  acknowledgeWorkerDock(db, {
    party,
    settlements: [{ dispatchId: failed, settlement: settlementOf(failed) }],
    acknowledged: true
  })
  expect(current()).toEqual([])
})

it('drops a failure the owner stopped', () => {
  const stopped = dispatch()
  settle(stopped, 'stopped', HOUR)
  expect(current()).toEqual([stopped])
  db.db
    .prepare(`INSERT INTO worker_dock_owner_stops(request_id, source, dispatch_id, confirmed, settlement)
      VALUES('stop-1', ?, ?, 1, ?)`)
    .run(session, stopped, settlementOf(stopped))
  expect(current()).toEqual([])
})

it('drops a failure a later dispatch of the same task replaced', () => {
  const shared = task()
  const first = dispatch(shared)
  settle(first, 'failed', 2 * HOUR)
  // The coordinator retries the task: it is ready again and gets a new dispatch.
  db.db.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(shared)
  const retry = dispatch(shared)
  const other = dispatch()
  settle(other, 'failed', 2 * HOUR)
  expect(new Set(current())).toEqual(new Set([retry, other]))
})

it('shows at most four failures, newest first', () => {
  const failures = [1, 2, 3, 4, 5, 6].map((minutes) => {
    const id = dispatch()
    settle(id, 'failed', minutes * 60_000)
    return id
  })
  expect(current()).toEqual(failures.slice(0, 4))
})

it('fences an unresolved launch or stop after an hour', () => {
  const launching = dispatch()
  settle(launching, 'start_unknown', 30 * 60_000)
  const stale = dispatch()
  settle(stale, 'start_unknown', 2 * HOUR)
  const stopping = dispatch()
  settle(stopping, 'stop_unknown', 3 * HOUR)
  expect(current()).toEqual([launching])
})

it('drops a ready worker with no fresh status a day after its last change', () => {
  const recent = dispatch()
  settle(recent, 'ready', 2 * HOUR)
  const stale = dispatch()
  settle(stale, 'ready', 25 * HOUR)
  // Before any status read the host cannot tell, so both stay.
  expect(new Set(current())).toEqual(new Set([recent, stale]))
  refreshWorkerDockActivity(db, party, {
    readAgentStatusOfPanes: () => [],
    readObservedAgentStatusPaneIdentityFn: () => null,
    getAgentStatusTerminalHandleForPaneKey: () => null,
    getTerminalProcessIncarnation: () => null
  } as unknown as Parameters<typeof refreshWorkerDockActivity>[2])
  expect(current()).toEqual([recent])
})

it('re-reads when a shown failure ages out, with no write to wake it', async () => {
  const failed = dispatch()
  settle(failed, 'failed', 4 * HOUR - 5 * 60_000)
  const emit = vi.fn<(snapshot: ReturnType<typeof readWorkerDock>) => void>()
  const unsubscribe = subscribeWorkerDock(db, party, emit, undefined, true, true)
  try {
    expect(emit.mock.lastCall?.[0].identities.map((row) => row.dispatchId)).toEqual([failed])
    await vi.advanceTimersByTimeAsync(6 * 60_000)
    expect(emit.mock.lastCall?.[0].identities).toEqual([])
  } finally {
    unsubscribe()
  }
})

it('arms the aging timer only for rows that can age out', () => {
  const row = (state: 'running' | 'failed' | 'unavailable', changedAt: number) => ({
    id: state,
    dispatchId: state,
    state,
    changedAt,
    settlement: null,
    ownerActionsAvailable: true,
    hasModel: false
  })
  const snapshot = (identities: ReturnType<typeof row>[]) => ({
    revision: 1,
    expired: false,
    identities,
    rows: [],
    results: [],
    anchor: null
  })
  expect(workerDockAgingDeadline(snapshot([row('running', NOW - 9 * HOUR)]), NOW)).toBeNull()
  expect(workerDockAgingDeadline(snapshot([row('failed', NOW - HOUR)]), NOW)).toBe(NOW + 3 * HOUR)
  // Past the hour an unknown row has, the day a ready one has is next.
  expect(workerDockAgingDeadline(snapshot([row('unavailable', NOW - 2 * HOUR)]), NOW)).toBe(
    NOW + 22 * HOUR
  )
})
