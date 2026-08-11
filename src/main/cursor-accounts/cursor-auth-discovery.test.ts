import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SyncDatabase from '../sqlite/sync-database'
import {
  cursorAccountId,
  discoverCursorAccount,
  resolveCursorStateDbPath
} from './cursor-auth-discovery'

let appDataDir: string

function seedStateDb(entries: Record<string, string>): string {
  const dbPath = resolveCursorStateDbPath(appDataDir)
  mkdirSync(join(appDataDir, 'Cursor', 'User', 'globalStorage'), { recursive: true })
  const db = new SyncDatabase(dbPath)
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')
  const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
  for (const [key, value] of Object.entries(entries)) {
    insert.run(key, value)
  }
  db.close()
  return dbPath
}

beforeEach(() => {
  appDataDir = mkdtempSync(join(tmpdir(), 'cursor-discovery-'))
})

afterEach(() => {
  rmSync(appDataDir, { recursive: true, force: true })
})

describe('discoverCursorAccount', () => {
  it('returns null when Cursor is not installed', () => {
    expect(discoverCursorAccount(resolveCursorStateDbPath(appDataDir))).toBeNull()
  })

  it('reads the signed-in account from cursorAuth/* keys', () => {
    const dbPath = seedStateDb({
      'cursorAuth/cachedEmail': 'dev@example.com',
      'cursorAuth/stripeMembershipType': 'pro',
      'cursorAuth/cachedSignUpType': 'Google',
      'cursorAuth/stripeSubscriptionStatus': 'active',
      'glass.lastSignedInAuthId': 'google-oauth2|user_123'
    })
    expect(discoverCursorAccount(dbPath)).toEqual({
      email: 'dev@example.com',
      authId: 'google-oauth2|user_123',
      membershipType: 'pro',
      signUpType: 'Google',
      subscriptionStatus: 'active',
      configDbPath: dbPath
    })
  })

  it('returns null when no cached email is present (signed out)', () => {
    const dbPath = seedStateDb({ 'cursorAuth/stripeMembershipType': 'free' })
    expect(discoverCursorAccount(dbPath)).toBeNull()
  })

  it('derives a stable id from the auth id', () => {
    expect(cursorAccountId('google-oauth2|user_123', 'dev@example.com')).toBe(
      cursorAccountId('google-oauth2|user_123', 'other@example.com')
    )
    expect(cursorAccountId(null, 'dev@example.com')).not.toBe(
      cursorAccountId(null, 'other@example.com')
    )
  })
})
