import { runLifecycleWriteTransaction } from '../../db/lifecycle-write-transaction-runner'
import { expect, it, vi } from 'vitest'
import { meterQuietQueries, runtimeFixture } from './worker-quiet-runtime.test-fixture'
import { CrewChanges } from '../../crew/crew-changes'
import { OrcaRuntimeWithCrewOperations } from '../../../workspaces/persisted-surfaces/crew-operations'

vi.mock('../../../workspaces/persisted-surfaces/orchestration-database-binding', () => ({
  OrcaRuntimeWithOrchestrationDatabaseBinding: class {}
}))

const fixture = runtimeFixture()

it('wakes an idle no-database watch when a database with a saved working dispatch binds', () => {
  const { db } = fixture
  const { run } = fixture.workers(1)
  const changes = new CrewChanges()
  let bound = false
  fixture.start({ changes, getDb: () => (bound ? db : null) })
  vi.advanceTimersByTime(60_000)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: bindCrewChanges only needs its prototype getters and the supplied change stream, without constructing runtime services.
  const runtime = Object.assign(Object.create(OrcaRuntimeWithCrewOperations.prototype), {
    crewChanges: changes
  }) as OrcaRuntimeWithCrewOperations
  bound = true
  runtime['bindCrewChanges'](db)
  vi.advanceTimersByTime(900_000)
  expect(db.getUnreadRunMailbox(run.id, 100, ['status'])).toHaveLength(1)
})

it.each([
  [2, 100],
  [2, 1000],
  [20, 100]
])(
  'bounds restart recovery by %i working dispatches with %i retained messages',
  (count, history) => {
    const { db } = fixture
    const { run, workers } = fixture.workers(count)
    const local = db.db.prepare(`INSERT INTO messages
      (id, run_id, from_handle, to_handle, subject, payload) VALUES (?, ?, 'worker', 'coordinator', '', ?)`)
    const relay = db.db.prepare(`INSERT INTO federation_relay_items
      (dispatch_id, direction, sequence, message_id, kind, payload, byte_count, acked_at)
      VALUES (?, 'to_home', ?, ?, 'status', ?, 0, '2026-11-12')`)
    runLifecycleWriteTransaction(db.db, 'seed_quiet_notice', () => {
      for (let n = 0; n < history; n++) {
        const retained = n % 2 ? 'legacy plain text' : JSON.stringify({ retained: n })
        local.run(`unrelated-${n}`, run.id, retained)
        relay.run(workers[0]!.id, n + 1, `unrelated-${n}`, JSON.stringify({ payload: retained }))
      }
      for (const worker of workers) {
        for (let n = 1; n <= 3; n++) {
          const quietNotice = {
            dispatchId: worker.id,
            turnStartedAt: 0,
            ordinal: n,
            observedAt: (n - 3) * 900_000,
            intervalMs: 900_000
          }
          local.run(
            `${worker.id}-${n}`,
            run.id,
            JSON.stringify({
              quietNotice: {
                ...quietNotice,
                ordinal: n - 1,
                observedAt: quietNotice.observedAt - 1
              }
            })
          )
          relay.run(
            worker.id,
            history + n,
            `${worker.id}-${n}`,
            JSON.stringify({ payload: JSON.stringify({ quietNotice }) })
          )
        }
      }
    })
    const meter = meterQuietQueries(db)
    let decoded = 0
    const parse = JSON.parse
    const parsing = vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
      decoded++
      return parse(text, reviver)
    })
    fixture.start()
    vi.advanceTimersByTime(60_000)
    // One host batch; at most one latest local and one latest relay row per requested worker.
    expect(meter.recoveryQueries).toBe(1)
    expect(meter.visits.local).toBeLessThanOrEqual(count)
    expect(meter.visits.relay).toBeLessThanOrEqual(count)
    expect(decoded).toBeLessThanOrEqual(count * 2)
    expect(meter.plans.join('\n')).toContain('idx_messages_worker_quiet_latest')
    expect(meter.plans.join('\n')).toContain('idx_relay_worker_quiet_latest')
    meter.restore()
    parsing.mockRestore()
    vi.advanceTimersByTime(3_540_000)
    const notices = db.getUnreadRunMailbox(run.id, 100, ['status'])
    expect(notices).toHaveLength(count)
    expect(notices.map((row) => JSON.parse(row.payload!).quietNotice.ordinal)).toEqual(
      Array(count).fill(4)
    )
    expect(notices.map((row) => JSON.parse(row.payload!).quietNotice.observedAt)).toEqual(
      Array(count).fill(1_800_000)
    )
  }
)
