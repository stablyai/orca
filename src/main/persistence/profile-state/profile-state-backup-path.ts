import { profileStateDatabaseFiles } from './profile-state-storage-classification'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const BACKUP_ID_PATTERN =
  /^([1-9]\d*)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/

export type ProfileStateDatabaseBackup = {
  id: string
  path: string
  createdAtMs: number
}

export function createProfileStateDatabaseBackupId(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new Error('Profile state backup timestamp must be a positive safe integer')
  }
  return `${now}-${randomUUID()}`
}

export function profileStateDatabaseBackupPath(databaseFile: string, id: string): string {
  if (parseBackupCreatedAt(id) === undefined) {
    throw new Error('Profile state backup ID is invalid')
  }
  return `${databaseFile}.backup.${id}.db`
}

/** Enumerate immutable recovery artifacts without opening the possibly damaged primary. */
export function profileStateDatabaseBackups(
  databaseFile: string
): readonly ProfileStateDatabaseBackup[] {
  const directory = dirname(databaseFile)
  const prefix = `${basename(databaseFile)}.backup.`
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return []
    }
    throw error
  }
  return entries
    .flatMap((name) => {
      if (typeof name !== 'string' || !name.startsWith(prefix) || !name.endsWith('.db')) {
        return []
      }
      const id = name.slice(prefix.length, -3)
      const createdAtMs = parseBackupCreatedAt(id)
      return createdAtMs === undefined ? [] : [{ id, path: join(directory, name), createdAtMs }]
    })
    .sort((left, right) => right.createdAtMs - left.createdAtMs || right.id.localeCompare(left.id))
}

function parseBackupCreatedAt(id: string): number | undefined {
  const match = BACKUP_ID_PATTERN.exec(id)
  const timestamp = match ? Number(match[1]) : 0
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : undefined
}

/** Preserve sidecars too if an external writer has opened an otherwise immutable backup. */
export function profileStateDatabaseBackupFiles(databaseFile: string): readonly string[] {
  return profileStateDatabaseBackups(databaseFile).flatMap(({ path }) =>
    profileStateDatabaseFiles(path).filter(existsSync)
  )
}
