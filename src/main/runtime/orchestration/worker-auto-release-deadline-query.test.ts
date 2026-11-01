import { describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'

describe('next automatic-release deadline', () => {
  it('reads federated deadlines through the partial index, not retained history', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const prepare = vi.spyOn(db.db, 'prepare')
      expect(db.nextWorkerTerminalAutoReleaseAtMs()).toBeNull()
      const sql = prepare.mock.calls.find(([query]) => query.includes('home_auto_release_at'))?.[0]
      prepare.mockRestore()
      expect(sql).toBeDefined()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: EXPLAIN QUERY PLAN rows always carry `detail`.
      const plan = db.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]
      expect(plan.some(({ detail }) => detail.includes('SCAN federated_dispatches'))).toBe(false)
      expect(
        plan.some(({ detail }) => detail.includes('idx_federated_dispatches_home_auto_release'))
      ).toBe(true)
    } finally {
      db.close()
    }
  })
})
