import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import { OrchestrationDb } from './orchestration/db'

vi.mock('../git/worktree', () => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/foo',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

describe('OrcaRuntimeRpcServer', () => {
  // Why: §6 test for the idempotent + hard-fail schema migration. A broken
  // migration must crash startup loudly rather than serve traffic against a
  // schema missing the delivered_at column.
  describe('orchestration DB migration (§3.2)', () => {
    it('is idempotent when delivered_at already exists', () => {
      // First open creates the column; second open should be a no-op.
      const db1 = new OrchestrationDb(':memory:')
      db1.close()
      // File path reuse is meaningless with :memory:, so use a tmp file.
      const tmpPath = join(mkdtempSync(join(tmpdir(), 'orca-orch-mig-')), 'orch.sqlite')
      const a = new OrchestrationDb(tmpPath)
      a.close()
      // Second construction must not throw "duplicate column name".
      expect(() => {
        const b = new OrchestrationDb(tmpPath)
        b.close()
      }).not.toThrow()
    })

    it('hard-fails startup when the migration cannot be applied', () => {
      // Simulate a migration error by monkey-patching the SQLite wrapper's exec.
      // If ALTER TABLE throws for any reason (e.g. disk full, permissions),
      // the constructor must propagate — not swallow and serve half-broken.
      //
      // Why the pre-seeded v2 DB: after the schema bundle, fresh DBs are
      // initialized directly at v3 via createTables() (which already includes
      // `delivered_at`), so the v2 → v3 ALTER is a no-op for new installs.
      // To exercise the hard-fail path we need a DB that actually has work
      // to migrate — a v2-shape file without the delivered_at column — so
      // the guarded ALTER runs and the stub can fire.
      const tmpPath = join(mkdtempSync(join(tmpdir(), 'orca-orch-mig-')), 'orch.sqlite')
      const seed = new Database(tmpPath)
      seed.exec(`
        CREATE TABLE messages (
          id            TEXT NOT NULL,
          from_handle   TEXT NOT NULL,
          to_handle     TEXT NOT NULL,
          subject       TEXT NOT NULL,
          body          TEXT NOT NULL DEFAULT '',
          type          TEXT NOT NULL DEFAULT 'status'
            CHECK(type IN (
              'status', 'dispatch', 'worker_done', 'merge_ready',
              'escalation', 'handoff', 'decision_gate', 'heartbeat'
            )),
          priority      TEXT NOT NULL DEFAULT 'normal'
            CHECK(priority IN ('normal', 'high', 'urgent')),
          thread_id     TEXT,
          payload       TEXT,
          read          INTEGER NOT NULL DEFAULT 0,
          sequence      INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `)
      seed.pragma('user_version = 2')
      seed.close()

      const realPrototype = Database.prototype as unknown as {
        exec: (sql: string) => unknown
      }
      const originalExec = realPrototype.exec
      realPrototype.exec = function (sql: string) {
        if (sql.includes('ALTER TABLE messages ADD COLUMN delivered_at')) {
          throw new Error('simulated migration failure')
        }
        return originalExec.call(this, sql)
      }
      try {
        expect(() => new OrchestrationDb(tmpPath)).toThrow('simulated migration failure')
      } finally {
        realPrototype.exec = originalExec
      }
    })
  })
})
