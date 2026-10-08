import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from '../../../../sqlite/sync-database'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { SCHEMA_VERSION } from '../contract-constants'
import { resolveOrchestrationMigrationStartVersion } from '../../orchestration-schema-version-skew'

/** A v43 database: today's schema less the v44 column, holding one message sent before it. */
function seedV43Database(path: string): string {
  const current = new OrchestrationDb(path)
  const { id } = current.insertMessage({ from: 'term_a', to: 'term_b', subject: 'before v44' })
  current.close()
  const raw = new Database(path)
  raw.exec('ALTER TABLE messages DROP COLUMN busy_delivery')
  raw.pragma('user_version = 43')
  raw.close()
  return id
}

describe('messages.busy_delivery (schema v44)', () => {
  const tempRoots: string[] = []

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function databasePath(): string {
    const root = mkdtempSync(join(tmpdir(), 'orca-busy-delivery-migration-'))
    tempRoots.push(root)
    return join(root, 'orchestration.db')
  }

  it('gives a v43 database the column, reading its earlier mail as queued', () => {
    const path = databasePath()
    const before = seedV43Database(path)
    const db = new OrchestrationDb(path)
    try {
      expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
      expect(db.getMessageById(before)?.busy_delivery).toBe('queue')
      const steered = db.insertMessage({
        from: 'term_a',
        to: 'term_b',
        subject: 'after',
        busyDelivery: 'steer'
      })
      expect(steered.busy_delivery).toBe('steer')
    } finally {
      db.close()
    }
  })

  it('creates a fresh database with it, defaulting to queue', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      expect(db.hasColumn('messages', 'busy_delivery')).toBe(true)
      expect(db.insertMessage({ from: 'term_a', to: 'term_b', subject: 'x' }).busy_delivery).toBe(
        'queue'
      )
    } finally {
      db.close()
    }
  })

  it('replays the chain for a database stamped v44 without the column', () => {
    const path = databasePath()
    seedV43Database(path)
    const raw = new Database(path)
    try {
      expect(resolveOrchestrationMigrationStartVersion(raw, 43, SCHEMA_VERSION)).toBe(43)
      expect(resolveOrchestrationMigrationStartVersion(raw, 44, SCHEMA_VERSION)).toBeLessThan(44)
    } finally {
      raw.close()
    }
  })
})
