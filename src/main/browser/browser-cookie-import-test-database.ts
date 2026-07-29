import { createCipheriv, pbkdf2Sync } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

type ChromiumCookieTestRow = {
  name: string
  value: string
  encryptedValue?: Buffer
}

export function createChromiumCookieTestDatabase(
  databasePath: string,
  rows: ChromiumCookieTestRow[],
  options: { journalMode?: 'wal' } = {}
): DatabaseSync {
  mkdirSync(join(databasePath, '..'), { recursive: true })
  const database = new DatabaseSync(databasePath)
  if (options.journalMode === 'wal') {
    database.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0')
  }
  database.exec(`
    CREATE TABLE cookies (
      creation_utc INTEGER NOT NULL,
      host_key TEXT NOT NULL,
      top_frame_site_key TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      encrypted_value BLOB NOT NULL DEFAULT X'',
      path TEXT NOT NULL,
      expires_utc INTEGER NOT NULL,
      is_secure INTEGER NOT NULL,
      is_httponly INTEGER NOT NULL,
      samesite INTEGER NOT NULL,
      source_scheme INTEGER NOT NULL DEFAULT 0,
      source_port INTEGER NOT NULL DEFAULT -1,
      last_update_utc INTEGER NOT NULL DEFAULT 0,
      has_cross_site_ancestor INTEGER NOT NULL DEFAULT 0,
      UNIQUE(host_key, top_frame_site_key, name, path, source_scheme, source_port)
    )
  `)
  const insert = database.prepare(`
    INSERT INTO cookies (
      creation_utc,
      host_key,
      top_frame_site_key,
      name,
      value,
      encrypted_value,
      path,
      expires_utc,
      is_secure,
      is_httponly,
      samesite,
      source_scheme,
      source_port,
      last_update_utc,
      has_cross_site_ancestor
    ) VALUES (?, ?, '', ?, ?, ?, '/', 0, 0, 0, 0, 0, -1, ?, 0)
  `)
  rows.forEach((row, index) => {
    insert.run(
      133_000_000_000_000 + index,
      '.example.com',
      row.name,
      row.value,
      row.encryptedValue ?? Buffer.alloc(0),
      0
    )
  })
  return database
}

export function encryptMacChromiumCookie(value: string, password: string): Buffer {
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
  return Buffer.concat([
    Buffer.from('v10'),
    cipher.update(Buffer.from(value, 'latin1')),
    cipher.final()
  ])
}
