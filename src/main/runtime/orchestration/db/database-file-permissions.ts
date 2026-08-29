import { chmodSync, existsSync } from 'node:fs'

export function hardenOrchestrationDatabaseFiles(dbPath: (string & {}) | ':memory:'): void {
  if (dbPath === ':memory:' || process.platform === 'win32') {
    // Why: Windows protects these files through Orca's current-user-only userData DACL; POSIX mode bits are inert there.
    return
  }
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      if (existsSync(path)) {
        chmodSync(path, 0o600)
      }
    } catch {
      // Why: best-effort — a mount that rejects chmod (SSHFS, some network shares) must not fail DB startup.
    }
  }
}
