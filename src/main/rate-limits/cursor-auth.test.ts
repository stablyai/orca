import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { getCursorStateDbPath, hasCursorAuthSession, readCursorAuthSession } from './cursor-auth'

function createStateDb(dir: string, entries: Record<string, string>): string {
  const dbPath = join(dir, 'state.vscdb')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)')
  const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
  for (const [key, value] of Object.entries(entries)) {
    insert.run(key, value)
  }
  db.close()
  return dbPath
}

describe('cursor-auth', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'orca-cursor-auth-test-'))
    dirs.push(dir)
    return dir
  }

  it('resolves a platform-specific state.vscdb path under the home Cursor install', () => {
    const path = getCursorStateDbPath()
    expect(path.endsWith(join('Cursor', 'User', 'globalStorage', 'state.vscdb'))).toBe(true)
  })

  it('returns missing when the database file is absent', () => {
    expect(readCursorAuthSession({ stateDbPath: join(tempDir(), 'missing.vscdb') })).toEqual({
      status: 'missing'
    })
  })

  it('returns missing when the access token key is empty', () => {
    const dbPath = createStateDb(tempDir(), {
      'cursorAuth/accessToken': '',
      'cursorAuth/cachedEmail': 'dev@example.com'
    })
    expect(readCursorAuthSession({ stateDbPath: dbPath })).toEqual({ status: 'missing' })
    expect(hasCursorAuthSession({ stateDbPath: dbPath })).toBe(false)
  })

  it('reads access token, email, membership, and refresh token', () => {
    const dbPath = createStateDb(tempDir(), {
      'cursorAuth/accessToken': 'access-token',
      'cursorAuth/refreshToken': 'refresh-token',
      'cursorAuth/cachedEmail': 'dev@example.com',
      'cursorAuth/stripeMembershipType': 'pro'
    })
    expect(readCursorAuthSession({ stateDbPath: dbPath })).toEqual({
      status: 'ok',
      session: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        email: 'dev@example.com',
        membershipType: 'pro'
      }
    })
    expect(hasCursorAuthSession({ stateDbPath: dbPath })).toBe(true)
  })

  it('redacts filesystem details when the database cannot be opened', () => {
    const dir = tempDir()
    const badPath = join(dir, 'not-a-db.vscdb')
    writeFileSync(badPath, 'not sqlite')
    expect(readCursorAuthSession({ stateDbPath: badPath, tempRoot: dir })).toEqual({
      status: 'error',
      error: 'Unable to read Cursor auth'
    })
  })
})
