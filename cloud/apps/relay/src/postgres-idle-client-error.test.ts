import pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { absorbPostgresIdleClientErrors } from './database.js'

describe('PostgreSQL idle-client failure handling', () => {
  it('absorbs the pool error without logging connection details', async () => {
    const pool = new pg.Pool()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      absorbPostgresIdleClientErrors(pool)
      expect(() => pool.emit('error', new Error('postgres://user:secret@database'))).not.toThrow()
      expect(warning).toHaveBeenCalledWith('[orca-relay] idle PostgreSQL client failed')
      expect(JSON.stringify(warning.mock.calls)).not.toContain('secret')
    } finally {
      warning.mockRestore()
      await pool.end()
    }
  })
})
