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
  // Migration must be idempotent and fail startup loudly rather than serve a schema missing delivered_at (design §6).
  describe('orchestration DB migration (§3.2)', () => {
    it('is idempotent when delivered_at already exists', () => {
      const db1 = new OrchestrationDb(':memory:')
      db1.close()
      // File path reuse is meaningless with :memory:, so use a tmp file.
      const tmpPath = join(mkdtempSync(join(tmpdir(), 'orca-orch-mig-')), 'orch.sqlite')
      const a = new OrchestrationDb(tmpPath)
      a.close()
      expect(() => {
        const b = new OrchestrationDb(tmpPath)
        b.close()
      }).not.toThrow()
    })

    it('hard-fails startup when the migration cannot be applied', () => {
      // Seed v2 without delivered_at so ALTER actually runs; fresh databases start at v3 and would bypass the injected exec failure.
      // Propagate migration failure (disk/permission/etc.) rather than serving incomplete schema.
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
