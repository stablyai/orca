import { describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { InProcessWorkerExitEvidence } from './in-process-worker-exit-evidence'
import { observeInProcessWorkerExits } from '../../../../ipc/pty/runtime/in-process-exit-observer'
import { exitListeners } from '../../../../providers/local-pty/local-pty-provider-state'

function incarnationOf(index: number): string {
  return `pty-${index}:00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

function seedExitedWorkers(
  db: OrchestrationDb,
  evidence: InProcessWorkerExitEvidence,
  count: number
) {
  const insert = db.db.prepare(
    `INSERT INTO worker_terminal_resources
      (id, origin_dispatch_id, owner_dispatch_id, terminal_handle, process_incarnation, host_scope)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  for (let index = 0; index < count; index++) {
    insert.run(
      `res-${index}`,
      `ctx-${index}`,
      `ctx-${index}`,
      `term-${index}`,
      incarnationOf(index),
      JSON.stringify({ kind: 'local', hostId: 'local' })
    )
    evidence.record(db, incarnationOf(index))
  }
}

/** Obligation lookups one unrelated shell exit costs. */
function lookupsForUnrelatedExit(
  db: OrchestrationDb,
  evidence: InProcessWorkerExitEvidence
): number {
  const prepare = vi.spyOn(db.db, 'prepare')
  evidence.record(db, 'pty-shell:00000000-0000-4000-8000-999999999999')
  const count = prepare.mock.calls.length
  prepare.mockRestore()
  return count
}

describe('in-process worker exit evidence', () => {
  it.each([20, 200])(
    'costs an exit the same few lookups with %i workers awaiting release',
    (retained) => {
      const db = new OrchestrationDb(':memory:')
      try {
        const evidence = new InProcessWorkerExitEvidence()
        seedExitedWorkers(db, evidence, retained)
        // One lookup for the exit itself plus two cleanup steps, whatever the population.
        expect(lookupsForUnrelatedExit(db, evidence)).toBe(3)
      } finally {
        db.close()
      }
    }
  )

  it('stops vouching for a worker once its release ends, however it ended', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const evidence = new InProcessWorkerExitEvidence()
      seedExitedWorkers(db, evidence, 4)
      expect(evidence.has(db, incarnationOf(0))).toBe(true)

      db.db
        .prepare(
          "UPDATE worker_terminal_resources SET release_state = 'released' WHERE id = 'res-0'"
        )
        .run()
      db.db
        .prepare(
          "UPDATE worker_terminal_resources SET ownership_state = 'transferred' WHERE id = 'res-1'"
        )
        .run()
      db.db.prepare("DELETE FROM worker_terminal_resources WHERE id IN ('res-2', 'res-3')").run()

      expect(evidence.has(db, incarnationOf(0))).toBe(false)
      expect(evidence.has(db, incarnationOf(1))).toBe(false)
      // Ended obligations drain through ordinary activity until an exit costs only its own lookup.
      lookupsForUnrelatedExit(db, evidence)
      expect(lookupsForUnrelatedExit(db, evidence)).toBe(1)
    } finally {
      db.close()
    }
  })

  it('vouches for nothing, and throws nothing, once its database cannot be read', () => {
    const db = new OrchestrationDb(':memory:')
    const evidence = new InProcessWorkerExitEvidence()
    seedExitedWorkers(db, evidence, 2)
    expect(evidence.has(db, incarnationOf(0))).toBe(true)
    db.close()

    expect(() => evidence.record(db, incarnationOf(1))).not.toThrow()
    expect(evidence.has(db, incarnationOf(0))).toBe(false)
  })

  it('keeps delivering later exit listeners when recording an exit fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const later = vi.fn()
    observeInProcessWorkerExits({
      recordInProcessPtyExit: () => {
        throw new Error('database is closed')
      }
    })
    exitListeners.add(later)
    try {
      // The provider's own delivery loop: one listener's throw would skip the rest.
      for (const listener of exitListeners) {
        listener({ id: 'pty-1', code: 0, incarnationId: '00000000-0000-4000-8000-000000000001' })
      }
      expect(later).toHaveBeenCalledTimes(1)
    } finally {
      exitListeners.delete(later)
      observeInProcessWorkerExits(undefined)
      warn.mockRestore()
    }
  })
})
