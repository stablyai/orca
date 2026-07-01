import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DbConnection } from '../../shared/database-types'
import {
  applyCap,
  DB_CONNECT_TIMEOUT_MS,
  DbTimeoutError,
  isLocalHost,
  normalizeDbError,
  raceWithTimeout,
  resolveDbConfig,
  resolveSslMode
} from './db-driver'

function makeConnection(overrides: Partial<DbConnection> = {}): DbConnection {
  return {
    id: 'c1',
    name: 'db',
    engine: 'postgres',
    host: 'db.example.com',
    port: 5432,
    database: 'app',
    user: 'admin',
    readOnly: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

describe('isLocalHost', () => {
  it.each(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', 'LOCALHOST'])(
    'treats %s as local',
    (host) => {
      expect(isLocalHost(host)).toBe(true)
    }
  )

  it.each(['db.example.com', '10.0.0.5', 'postgres.internal'])('treats %s as remote', (host) => {
    expect(isLocalHost(host)).toBe(false)
  })
})

describe('resolveSslMode (smart-by-host)', () => {
  it('defaults localhost to disable when ssl is unset', () => {
    expect(resolveSslMode(undefined, 'localhost')).toBe('disable')
  })

  it('defaults a remote host to verify-full when ssl is unset', () => {
    expect(resolveSslMode(undefined, 'db.example.com')).toBe('verify-full')
  })

  it('honors an explicit mode over the host heuristic', () => {
    expect(resolveSslMode('insecure-no-verify', 'db.example.com')).toBe('insecure-no-verify')
    expect(resolveSslMode('verify-full', 'localhost')).toBe('verify-full')
  })
})

describe('resolveDbConfig', () => {
  it('collapses smart-by-host SSL and carries the decrypted password at point-of-use', () => {
    const cfg = resolveDbConfig(makeConnection(), 's3cr3t')
    expect(cfg.ssl).toBe('verify-full')
    expect(cfg.password).toBe('s3cr3t')
    expect(cfg.readOnly).toBe(false)
  })

  it('defaults a remote host with no explicit ssl to verify-full', () => {
    expect(resolveDbConfig(makeConnection({ host: 'remote.db' }), undefined).ssl).toBe(
      'verify-full'
    )
  })
})

describe('normalizeDbError (no credential leak)', () => {
  it('maps known driver codes to safe messages', () => {
    expect(normalizeDbError({ code: '28P01' }).code).toBe('auth_failed')
    expect(normalizeDbError({ code: 'ER_ACCESS_DENIED_ERROR' }).code).toBe('auth_failed')
    expect(normalizeDbError({ code: '3D000' }).code).toBe('database_not_found')
    expect(normalizeDbError({ code: 'ECONNREFUSED' }).code).toBe('connection_refused')
    expect(normalizeDbError({ code: 'ENOTFOUND' }).code).toBe('host_unreachable')
    expect(normalizeDbError({ code: 'ETIMEDOUT' }).code).toBe('timeout')
    expect(normalizeDbError({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }).code).toBe('tls_error')
  })

  it('maps a DbTimeoutError to the timeout code', () => {
    expect(normalizeDbError(new DbTimeoutError()).code).toBe('timeout')
  })

  it('maps fail-closed credential-store errors to decrypt_failed', () => {
    expect(normalizeDbError(new Error('db_secret_unknown_format')).code).toBe('decrypt_failed')
  })

  it('falls back to unknown for unrecognized errors', () => {
    expect(normalizeDbError({ code: 'WAT' }).code).toBe('unknown')
    expect(normalizeDbError('a string').code).toBe('unknown')
  })

  it('never forwards the raw message (DSN/password) in the safe payload', () => {
    const raw = Object.assign(
      new Error('password authentication failed for "admin" postgres://admin:s3cr3t@db:5432/app'),
      { code: '28P01' }
    )
    const safe = normalizeDbError(raw)
    const serialized = JSON.stringify(safe)
    expect(serialized).not.toContain('s3cr3t')
    expect(serialized).not.toContain('postgres://')
    expect(serialized).not.toContain('admin')
  })
})

describe('applyCap (introspection overflow)', () => {
  it('marks truncated and slices when rows exceed the cap', () => {
    // Level queried with cap+1, so 3 rows for a cap of 2 means overflow.
    expect(applyCap([1, 2, 3], 2)).toEqual({ kept: [1, 2], truncated: true })
  })

  it('keeps all rows and is not truncated at or below the cap', () => {
    expect(applyCap([1, 2], 2)).toEqual({ kept: [1, 2], truncated: false })
    expect(applyCap([1], 2)).toEqual({ kept: [1], truncated: false })
  })
})

describe('raceWithTimeout', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves with the wrapped value when it settles first', async () => {
    await expect(raceWithTimeout(Promise.resolve('ok'), DB_CONNECT_TIMEOUT_MS)).resolves.toBe('ok')
  })

  it('propagates a wrapped rejection', async () => {
    await expect(
      raceWithTimeout(Promise.reject(new Error('boom')), DB_CONNECT_TIMEOUT_MS)
    ).rejects.toThrow('boom')
  })

  it('rejects with DbTimeoutError and runs onTimeout when the deadline passes', async () => {
    vi.useFakeTimers()
    const onTimeout = vi.fn()
    // A promise that never settles — only the timeout can win.
    const pending = raceWithTimeout<never>(new Promise<never>(() => {}), 1000, onTimeout)
    const assertion = expect(pending).rejects.toBeInstanceOf(DbTimeoutError)
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })
})
