import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../../sqlite/sync-database'
import { readCursorProfile } from './cursor-profile'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-cursor-profile-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeStateDb(path: string, rows: Record<string, string | Uint8Array>): void {
  const db = new SyncDatabase(path)
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')
  const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
  for (const [key, value] of Object.entries(rows)) {
    insert.run(key, value)
  }
  db.close()
}

describe('readCursorProfile', () => {
  it('reports a missing database as missing', () => {
    expect(readCursorProfile(join(dir, 'state.vscdb'))).toEqual({ status: 'missing' })
  })

  it('reads the stored session from a good database', () => {
    const path = join(dir, 'state.vscdb')
    writeStateDb(path, {
      'cursorAuth/accessToken': 'token-1',
      'cursorAuth/cachedEmail': new TextEncoder().encode('dev@example.com'),
      'cursorAuth/stripeMembershipType': 'pro',
      'unrelated/key': 'ignored'
    })

    expect(readCursorProfile(path)).toEqual({
      status: 'ok',
      profile: {
        accessToken: 'token-1',
        email: 'dev@example.com',
        membershipType: 'pro',
        subscriptionStatus: null
      }
    })
  })

  it('reports a corrupt database as an error', () => {
    const path = join(dir, 'state.vscdb')
    writeFileSync(path, 'not a sqlite database'.repeat(100))

    expect(readCursorProfile(path)).toEqual({
      status: 'error',
      error: 'Unable to read the Cursor desktop login'
    })
  })

  it('reports a database another writer holds locked as an error', () => {
    const path = join(dir, 'state.vscdb')
    writeStateDb(path, { 'cursorAuth/accessToken': 'token-1' })
    const holder = new SyncDatabase(path)
    holder.exec('PRAGMA journal_mode = DELETE')
    holder.exec('BEGIN EXCLUSIVE')
    try {
      expect(readCursorProfile(path)).toEqual({
        status: 'error',
        error: 'Unable to read the Cursor desktop login'
      })
    } finally {
      holder.exec('ROLLBACK')
      holder.close()
    }
  })
})
