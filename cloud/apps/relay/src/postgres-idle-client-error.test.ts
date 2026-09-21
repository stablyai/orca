import { describe, expect, it, vi } from 'vitest'
import { absorbPostgresIdleClientErrors } from './database.js'

describe('PostgreSQL idle-client failure handling', () => {
  it('absorbs the pool error without logging connection details', () => {
    let listener: ((error: Error) => void) | undefined
    const pool = {
      on: vi.fn((_event: string, value: (error: Error) => void) => {
        listener = value
        return pool
      })
    }
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    absorbPostgresIdleClientErrors(pool as never)
    expect(() => listener?.(new Error('postgres://user:secret@database'))).not.toThrow()
    expect(warning).toHaveBeenCalledWith('[orca-relay] idle PostgreSQL client failed')
    expect(JSON.stringify(warning.mock.calls)).not.toContain('secret')

    warning.mockRestore()
  })
})
