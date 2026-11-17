import { chmodSync, existsSync } from 'node:fs'

/** Restrict a SQLite database and its sidecars to the owning user. */
export function hardenSqliteDatabaseFiles(dbPath: (string & {}) | ':memory:'): void {
  if (dbPath === ':memory:' || process.platform === 'win32') {
    // Windows uses current-user userData DACLs; POSIX mode bits have no effect.
    return
  }
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      if (existsSync(path)) {
        chmodSync(path, 0o600)
      }
    } catch {
      // Network filesystems may reject chmod; permission hardening must not prevent DB startup.
    }
  }
}
