import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

describe.skipIf(process.platform === 'win32')('orchestration database permissions', () => {
  let directory: string | undefined
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    if (directory) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('restricts the database and live SQLite sidecars to the current user', () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-orchestration-permissions-'))
    const dbPath = join(directory, 'orchestration.db')
    db = new OrchestrationDb(dbPath)

    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
  })
})
