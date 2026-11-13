import { runLifecycleWriteTransaction } from '../../db/lifecycle-write-transaction-runner'
import { expect, it, vi } from 'vitest'
import { meterQuietQueries, runtimeFixture } from './worker-quiet-runtime.test-fixture'

const fixture = runtimeFixture()

it.each([
  [100, 0],
  [1000, 0],
  [100, 1],
  [1000, 1]
])(
  'examines only live attachments with %i retained completed rows and %i live worker',
  (history, live) => {
    const { db } = fixture
    const insert = db.db.prepare(`INSERT INTO remote_dispatch_attachments
      (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, pane_key, terminal_handle, state)
      VALUES (?, 'task', 'peer', 'epoch', ?, 'term_worker', ?)`)
    runLifecycleWriteTransaction(db.db, 'seed_quiet_notice', () => {
      for (let n = 0; n < history; n++) {
        insert.run(`completed-${n}`, `pane-${n}`, 'succeeded')
      }
      if (live) {
        insert.run('live', 'live-pane', 'ready')
      }
    })
    const meter = meterQuietQueries(db)
    fixture.start()
    vi.advanceTimersByTime(120_000)
    // Each sweep may examine the one live worker; completed history owes no output.
    expect(meter.visits.attachment).toBeLessThanOrEqual(live * 3)
    expect(meter.visits.attachment).toBeGreaterThanOrEqual(live)
    expect(meter.plans.join('\n')).toContain('idx_remote_dispatch_attachments_active_pane')
    expect(meter.plans.join('\n')).not.toContain('SCAN remote_dispatch_attachments\n')
  }
)
