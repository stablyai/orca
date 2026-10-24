import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, toNamespacedPath } from 'node:path'
import Database from './sqlite/sync-database'
import { writeProfileStateDatabaseSnapshotAsync } from './persistence/profile-state/profile-state-database-snapshot'
import { snapshotFileHash } from './update-snapshot-file'

const SIDECARS = ['', '-wal', '-journal']

async function captureHashes(source: string): Promise<(string | null)[]> {
  return Promise.all(
    SIDECARS.map(async (suffix) => {
      try {
        return await snapshotFileHash(`${source}${suffix}`)
      } catch (error) {
        if (suffix && error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return null
        }
        throw error
      }
    })
  )
}

async function publishDatabaseCopy(source: string, target: string): Promise<void> {
  const db = new Database(toNamespacedPath(source), { readonly: true, fileMustExist: true })
  try {
    await writeProfileStateDatabaseSnapshotAsync(db, toNamespacedPath(target), {
      validateStagedSnapshot: (path) => {
        const copy = new Database(path, { readonly: true, fileMustExist: true })
        try {
          if (copy.pragma('quick_check', { simple: true }) !== 'ok') {
            throw new Error('Update backup database validation failed')
          }
        } finally {
          copy.close()
        }
      }
    })
  } finally {
    db.close()
  }
}

/** Chromium can hold an exclusive SQLite lock; validate a stable byte capture without touching its owner. */
export async function snapshotUpdateDatabase(source: string, target: string): Promise<void> {
  try {
    await publishDatabaseCopy(source, target)
    return
  } catch {
    // Never copy a bare DB while ignoring a committed WAL or rollback journal.
  }
  const staging = await mkdtemp(join(dirname(target), '.sqlite-capture-'))
  const captured = join(staging, 'state.db')
  try {
    const before = await captureHashes(source)
    for (const [index, suffix] of SIDECARS.entries()) {
      if (before[index] !== null) {
        await copyFile(`${source}${suffix}`, `${captured}${suffix}`)
      }
    }
    const [copied, after] = await Promise.all([captureHashes(captured), captureHashes(source)])
    if (
      JSON.stringify(before) !== JSON.stringify(copied) ||
      JSON.stringify(before) !== JSON.stringify(after)
    ) {
      throw new Error('Database changed during its locked-file capture; retry before updating')
    }
    // Recovery, if needed, runs only on the private captured copy.
    const recovered = new Database(toNamespacedPath(captured), { fileMustExist: true })
    try {
      recovered.pragma('quick_check')
    } finally {
      recovered.close()
    }
    await publishDatabaseCopy(captured, target)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
