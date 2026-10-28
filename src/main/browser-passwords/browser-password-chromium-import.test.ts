import { createCipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DetectionModule from '../browser/cookies/sources/browser-cookie-detection-types'
import type * as SnapshotModule from '../browser/chromium-cookie-snapshot'
import type { EncryptionKeyResult } from '../browser/cookies/sources/browser-cookie-sqlite'

type FixtureState = {
  root: string
  key: EncryptionKeyResult | null
  keyRequests: number
  snapshotPaths: string[]
}

const { state } = vi.hoisted(() => {
  const state: FixtureState = { root: '', key: null, keyRequests: 0, snapshotPaths: [] }
  return { state }
})

vi.mock('../browser/cookies/sources/browser-cookie-detection-types', async (importOriginal) => ({
  ...(await importOriginal<typeof DetectionModule>()),
  browserRootPath: () => state.root
}))

vi.mock('../browser/cookies/sources/browser-cookie-key', () => ({
  getEncryptionKey: () => {
    state.keyRequests += 1
    return state.key
  }
}))

vi.mock('../browser/chromium-cookie-snapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof SnapshotModule>()
  return {
    ...actual,
    createChromiumCookieSnapshot: (
      ...args: Parameters<typeof actual.createChromiumCookieSnapshot>
    ) => {
      const snapshot = actual.createChromiumCookieSnapshot(...args)
      state.snapshotPaths.push(snapshot.databasePath)
      return snapshot
    }
  }
})

import { readChromiumBrowserPasswords } from './browser-password-chromium-import'

const cbcKey = randomBytes(16)

function encryptV10(plain: string): Buffer {
  const cipher = createCipheriv('aes-128-cbc', cbcKey, Buffer.alloc(16, ' '))
  return Buffer.concat([Buffer.from('v10'), cipher.update(plain, 'utf8'), cipher.final()])
}

type LoginFixture = {
  origin: string
  username: string
  password: Buffer
  blacklisted?: 0 | 1
  scheme?: number
  dateCreated?: bigint
}

function writeLoginDatabase(fileName: string, logins: LoginFixture[]): void {
  const dir = join(state.root, 'Default')
  mkdirSync(dir, { recursive: true })
  const database = new DatabaseSync(join(dir, fileName))
  database.exec(`
    CREATE TABLE logins (
      origin_url VARCHAR NOT NULL,
      action_url VARCHAR,
      username_value VARCHAR,
      password_value BLOB,
      signon_realm VARCHAR NOT NULL,
      date_created INTEGER NOT NULL,
      blacklisted_by_user INTEGER NOT NULL,
      scheme INTEGER NOT NULL
    )
  `)
  const insert = database.prepare(
    'INSERT INTO logins (origin_url, username_value, password_value, signon_realm, date_created, blacklisted_by_user, scheme) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  for (const login of logins) {
    insert.run(
      login.origin,
      login.username,
      login.password,
      login.origin,
      login.dateCreated ?? 0n,
      login.blacklisted ?? 0,
      login.scheme ?? 0
    )
  }
  database.close()
}

// 2024-01-01T00:00:00Z in Chrome's microseconds-since-1601.
const JAN_2024_MS = Date.UTC(2024, 0, 1)
const JAN_2024_CHROME = (BigInt(JAN_2024_MS) + 11_644_473_600_000n) * 1000n

describe('readChromiumBrowserPasswords', () => {
  beforeEach(() => {
    state.root = mkdtempSync(join(tmpdir(), 'orca-chromium-passwords-test-'))
    state.key = { mode: 'aes-128-cbc', keysByVersion: { v10: cbcKey } }
    state.keyRequests = 0
    state.snapshotPaths = []
  })

  afterEach(() => {
    rmSync(state.root, { recursive: true, force: true })
  })

  it('decrypts v10, counts v20, skips never-save and non-form rows, merges both databases', async () => {
    writeLoginDatabase('Login Data', [
      {
        origin: 'https://example.com/login',
        username: 'alice',
        password: encryptV10('hunter2'),
        dateCreated: JAN_2024_CHROME
      },
      { origin: 'https://never.test/', username: '', password: Buffer.alloc(0), blacklisted: 1 },
      { origin: 'https://auth.test/', username: 'basic', password: encryptV10('x'), scheme: 1 },
      { origin: 'https://federated.test/', username: 'fed', password: Buffer.alloc(0) },
      { origin: 'https://bound.test/', username: 'v20', password: Buffer.from('v20opaque-bytes') }
    ])
    writeLoginDatabase('Login Data For Account', [
      { origin: 'https://example.com/login', username: 'alice', password: encryptV10('hunter2') },
      { origin: 'https://account.test/', username: 'bob', password: encryptV10('pässwörd') }
    ])

    const result = await readChromiumBrowserPasswords({
      browserFamily: 'chrome',
      profileDirectory: 'Default'
    })

    expect(result).toEqual({
      ok: true,
      undecryptable: 1,
      rows: [
        {
          origin: 'https://example.com/login',
          username: 'alice',
          password: 'hunter2',
          createdAt: JAN_2024_MS
        },
        { origin: 'https://account.test/', username: 'bob', password: 'pässwörd' }
      ]
    })
    expect(state.snapshotPaths).toHaveLength(2)
    expect(state.snapshotPaths.some((path) => existsSync(path))).toBe(false)
  })

  it('never fetches the key when every value is app-bound', async () => {
    writeLoginDatabase('Login Data', [
      { origin: 'https://bound.test/', username: 'u', password: Buffer.from('v20opaque') }
    ])
    const result = await readChromiumBrowserPasswords({
      browserFamily: 'chrome',
      profileDirectory: 'Default'
    })
    expect(result).toEqual({ ok: true, rows: [], undecryptable: 1 })
    expect(state.keyRequests).toBe(0)
  })

  it('fails when the key is unavailable', async () => {
    writeLoginDatabase('Login Data', [
      { origin: 'https://a.test/', username: 'u', password: encryptV10('secret') }
    ])
    state.key = null
    expect(
      await readChromiumBrowserPasswords({ browserFamily: 'chrome', profileDirectory: 'Default' })
    ).toMatchObject({ ok: false, reason: 'key-unavailable' })
  })

  it('reports a profile without login databases, and refuses unsafe profile names', async () => {
    expect(
      await readChromiumBrowserPasswords({ browserFamily: 'chrome', profileDirectory: 'Default' })
    ).toMatchObject({ ok: false, reason: 'not-found' })
    expect(
      await readChromiumBrowserPasswords({ browserFamily: 'chrome', profileDirectory: '../x' })
    ).toMatchObject({ ok: false, reason: 'invalid-profile' })
  })
})
