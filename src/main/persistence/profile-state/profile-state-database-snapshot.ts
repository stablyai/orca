import { profileStateDatabaseFiles } from './profile-state-storage-classification'
import { access, mkdir, open, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import Database from '../../sqlite/sync-database'
import { hardenSqliteDatabaseFiles } from '../../sqlite/harden-database-files'
import { durableWriteTempPath, renameDurable } from '../../durable-file-write'

/** The caller owns the destination and keeps the source open until this backup settles. */
export async function writeProfileStateDatabaseSnapshotAsync(
  db: Database.Database,
  targetPath: string,
  options: {
    temporaryPath?: string
    validateStagedSnapshot?: (stagingPath: string) => Promise<void> | void
  } = {}
): Promise<void> {
  if (targetPath.length === 0 || targetPath.includes('\0')) {
    throw new Error('Profile state snapshot path is invalid')
  }
  if (db.isTransaction) {
    throw new Error('Profile state database snapshot requires an idle database connection')
  }
  await mkdir(dirname(targetPath), { recursive: true })
  await assertSnapshotTargetIsSeparate(db, targetPath)
  await assertNoSnapshotSidecars(targetPath)
  const temporaryPath = options.temporaryPath ?? durableWriteTempPath(targetPath)
  let published = false
  let created = false
  try {
    // Pre-create privately: the native backup otherwise creates a world-readable temporary file.
    const temporary = await open(temporaryPath, 'wx', 0o600)
    created = true
    await temporary.close()
    await db.backup(temporaryPath)
    // The native copy preserves WAL mode; snapshots must not create sidecars when opened read-only.
    const snapshot = new Database(temporaryPath, { fileMustExist: true })
    try {
      if (snapshot.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') {
        throw new Error('Profile state snapshot could not become a self-contained database')
      }
    } finally {
      snapshot.close()
    }
    hardenSqliteDatabaseFiles(temporaryPath)
    const completed = await open(temporaryPath, 'r+')
    try {
      await completed.sync()
    } finally {
      await completed.close()
    }
    await options.validateStagedSnapshot?.(temporaryPath)
    await assertNoSnapshotSidecars(targetPath)
    await renameDurable(temporaryPath, targetPath)
    published = true
  } finally {
    if (created && !published) {
      await rm(temporaryPath, { force: true })
    }
    if (created) {
      await Promise.all(
        ['-wal', '-shm', '-journal'].map((suffix) =>
          rm(`${temporaryPath}${suffix}`, { force: true })
        )
      )
    }
  }
}

async function assertSnapshotTargetIsSeparate(
  db: Database.Database,
  targetPath: string
): Promise<void> {
  const target = await realpath(targetPath).catch(async (error: unknown) => {
    if (!isMissingPath(error)) {
      throw error
    }
    return resolve(await realpath(dirname(targetPath)), basename(targetPath))
  })
  const databases = db.prepare('PRAGMA database_list').all()
  for (const database of databases) {
    if (typeof database.file !== 'string' || database.file.length === 0) {
      continue
    }
    const source = await realpath(database.file)
    if (profileStateDatabaseFiles(source).includes(target)) {
      throw new Error('Profile state snapshot cannot replace a source database or its sidecars')
    }
    // realpath preserves case aliases on macOS; file identity also protects absent sidecar names.
    const sourceInfo = await stat(source, { bigint: true })
    for (const candidate of new Set([target, target.replace(/-(?:wal|shm|journal)$/i, '')])) {
      const targetInfo = await stat(candidate, { bigint: true }).catch((error: unknown) => {
        if (!isMissingPath(error)) {
          throw error
        }
        return undefined
      })
      if (targetInfo?.dev === sourceInfo.dev && targetInfo.ino === sourceInfo.ino) {
        throw new Error('Profile state snapshot cannot replace a source database or its sidecars')
      }
    }
  }
}

async function assertNoSnapshotSidecars(targetPath: string): Promise<void> {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const exists = await access(`${targetPath}${suffix}`).then(
      () => true,
      (error: unknown) => {
        if (!isMissingPath(error)) {
          throw error
        }
        return false
      }
    )
    if (exists) {
      throw new Error('Profile state snapshot destination has SQLite sidecars')
    }
  }
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
