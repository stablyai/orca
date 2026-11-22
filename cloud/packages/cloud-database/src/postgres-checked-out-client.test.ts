import { EventEmitter } from 'node:events'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { absorbPostgresClientErrors } from './cloud-database.js'

describe('a PostgreSQL client', () => {
  it('survives Postgres ending its session while checked out', () => {
    const pool = new EventEmitter()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the function only subscribes to the pool's events.
    absorbPostgresClientErrors(pool as unknown as pg.Pool, 'connector')
    const client = new EventEmitter()
    pool.emit('connect', client)
    const terminated = Object.assign(new Error('Connection terminated unexpectedly'), {
      code: '57P01'
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // A checked-out client has no pool listener; with none of its own, this emit throws.
      expect(() => client.emit('error', terminated)).not.toThrow()
      expect(warning).toHaveBeenCalledWith(
        '[orca-connector] PostgreSQL client failed: 57P01 Connection terminated unexpectedly'
      )
    } finally {
      warning.mockRestore()
    }
  })
})
