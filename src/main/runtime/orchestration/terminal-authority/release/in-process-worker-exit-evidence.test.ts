import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { InProcessWorkerExitEvidence } from './in-process-worker-exit-evidence'

function seedWorker(db: OrchestrationDb, index: number): string {
  const processIncarnation = `pty-${index}:00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
  db.db
    .prepare(
      `INSERT INTO worker_terminal_resources
        (id, origin_dispatch_id, owner_dispatch_id, prior_owner_dispatch_ids, terminal_handle,
         process_incarnation, host_scope, ownership_state, release_state)
       VALUES (?, ?, ?, '[]', ?, ?, ?, 'owned', 'not_requested')`
    )
    .run(
      `res-${index}`,
      `ctx-${index}`,
      `ctx-${index}`,
      `term-${index}`,
      processIncarnation,
      JSON.stringify({ kind: 'local', hostId: 'local' })
    )
  return processIncarnation
}

describe('in-process worker exit evidence', () => {
  it('holds exits only while their workers await release', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const evidence = new InProcessWorkerExitEvidence()
      const incarnations = Array.from({ length: 20 }, (_, index) => seedWorker(db, index))
      for (const incarnation of incarnations) {
        evidence.record(db, incarnation)
      }
      evidence.record(db, 'pty-plain-shell:00000000-0000-4000-8000-999999999999')
      expect(evidence.size).toBe(20)

      // Release, transfer and removal all end the obligation.
      const release = db.db.prepare(
        "UPDATE worker_terminal_resources SET release_state = 'released' WHERE id = ?"
      )
      for (let index = 0; index < 15; index++) {
        release.run(`res-${index}`)
      }
      db.db
        .prepare(
          "UPDATE worker_terminal_resources SET ownership_state = 'transferred' WHERE id = 'res-17'"
        )
        .run()
      db.db.prepare("DELETE FROM worker_terminal_resources WHERE id = 'res-18'").run()

      expect(evidence.has(db, incarnations[19]!)).toBe(true)
      expect(evidence.has(db, incarnations[0]!)).toBe(false)
      expect(evidence.size).toBe(3)
    } finally {
      db.close()
    }
  })
})
