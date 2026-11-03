import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../../sqlite/sync-database'
import { readKiroCliCredentials } from './kiro-cli-credentials'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-kiro-cli-credentials-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// Mirrors the two kiro-cli tables Orca reads; every value here is fake.
function writeKiroDb(path: string, rows: { token?: string | Uint8Array; profile?: string }): void {
  const db = new SyncDatabase(path)
  db.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)')
  db.exec('CREATE TABLE state (key TEXT PRIMARY KEY, value BLOB)')
  if (rows.token !== undefined) {
    db.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?)').run(
      'kirocli:odic:token',
      rows.token
    )
  }
  if (rows.profile !== undefined) {
    db.prepare('INSERT INTO state (key, value) VALUES (?, ?)').run(
      'api.codewhisperer.profile',
      rows.profile
    )
  }
  db.close()
}

const TOKEN = JSON.stringify({
  access_token: 'fake-access',
  refresh_token: 'fake-refresh',
  expires_at: '2030-01-01T00:00:00.000000Z',
  region: 'us-east-1'
})
const PROFILE = JSON.stringify({
  arn: 'arn:aws:codewhisperer:us-east-1:111122223333:profile/FAKEPROFILE',
  profile_name: 'fake'
})

describe('readKiroCliCredentials', () => {
  it('reports a missing database as missing', () => {
    expect(readKiroCliCredentials(join(dir, 'data.sqlite3'))).toEqual({ status: 'missing' })
  })

  it('reads the access token and profile ARN without the refresh token', () => {
    const path = join(dir, 'data.sqlite3')
    writeKiroDb(path, { token: TOKEN, profile: PROFILE })

    const result = readKiroCliCredentials(path)

    expect(result).toEqual({
      status: 'ok',
      credentials: {
        accessToken: 'fake-access',
        expiresAt: '2030-01-01T00:00:00.000000Z',
        profileArn: 'arn:aws:codewhisperer:us-east-1:111122223333:profile/FAKEPROFILE'
      }
    })
    expect(JSON.stringify(result)).not.toContain('fake-refresh')
  })

  it('reads a token stored as bytes', () => {
    const path = join(dir, 'data.sqlite3')
    writeKiroDb(path, { token: new TextEncoder().encode(TOKEN), profile: PROFILE })

    expect(readKiroCliCredentials(path)).toMatchObject({ status: 'ok' })
  })

  it('treats a logged-out kiro-cli as missing', () => {
    const path = join(dir, 'data.sqlite3')
    writeKiroDb(path, { profile: PROFILE })

    expect(readKiroCliCredentials(path)).toEqual({ status: 'missing' })
  })

  it('reports a token without an access token as an error', () => {
    const path = join(dir, 'data.sqlite3')
    writeKiroDb(path, {
      token: JSON.stringify({ refresh_token: 'fake-refresh' }),
      profile: PROFILE
    })

    expect(readKiroCliCredentials(path)).toEqual({
      status: 'error',
      error: 'Unable to read the Kiro CLI login'
    })
  })

  it('reports a corrupt database as an error', () => {
    const path = join(dir, 'data.sqlite3')
    writeFileSync(path, 'not a sqlite database'.repeat(100))

    expect(readKiroCliCredentials(path)).toEqual({
      status: 'error',
      error: 'Unable to read the Kiro CLI login'
    })
  })
})
