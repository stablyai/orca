import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createCipheriv, pbkdf2Sync } from 'crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readChromiumLogins } from './chromium-login-import'
import {
  PBKDF2_SALT,
  PBKDF2_ITERATIONS,
  PBKDF2_KEY_LENGTH,
  type EncryptionKeyResult
} from './chromium-value-decrypt'

let dir: string
const key = pbkdf2Sync('pw', PBKDF2_SALT, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, 'sha1')
const keyResult: EncryptionKeyResult = { key, mode: 'aes-128-cbc' }

function encV10(plaintext: string): Buffer {
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
  return Buffer.concat([Buffer.from('v10'), cipher.update(plaintext, 'utf8'), cipher.final()])
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-logins-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

type LoginRow = { origin: string; user: string; pass: Buffer; blk?: number }

function buildLoginDb(rows: LoginRow[]): string {
  const dbPath = join(dir, 'Login Data')
  const db = new DatabaseSync(dbPath)
  db.exec(
    'CREATE TABLE logins (origin_url TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER)'
  )
  const stmt = db.prepare(
    'INSERT INTO logins (origin_url, username_value, password_value, blacklisted_by_user) VALUES (?,?,?,?)'
  )
  for (const r of rows) {
    stmt.run(r.origin, r.user, r.pass, r.blk ?? 0)
  }
  db.close()
  return dbPath
}

describe('readChromiumLogins', () => {
  it('reads and decrypts valid logins, dropping blocklisted and empty rows', () => {
    const dbPath = buildLoginDb([
      { origin: 'https://github.com/login', user: 'me', pass: encV10('s3cret') },
      { origin: 'https://example.com', user: '', pass: Buffer.alloc(0), blk: 1 }, // blocklist
      { origin: 'https://empty.com', user: '', pass: Buffer.alloc(0) } // empty
    ])
    const logins = readChromiumLogins(dbPath, keyResult)
    expect(logins).toEqual([
      { origin: 'https://github.com/login', username: 'me', password: 's3cret' }
    ])
  })
})
