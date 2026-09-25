import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  durableWriteTempPath,
  writeFileDurable,
  writeFileDurableSync
} from '../../durable-file-write'
import {
  readProfileStateSnapshot,
  stageProfileStateJsonCompatibility,
  acceptProfileStateJsonCompatibility
} from './profile-state-documents'
import type Database from '../../sqlite/sync-database'
import { writeVersionedProfileStateExport } from './profile-state-versioned-export'
import { ProfileStateRevisionConflictError } from './profile-state-document-validation'

/** Preparation may leave a recovery export, but cannot change SQLite acceptance or canonical JSON. */
export class ProfileStateExportPreparationError extends Error {
  constructor(cause: unknown) {
    super(
      `Profile state compatibility export preparation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    )
    this.name = 'ProfileStateExportPreparationError'
  }
}

function readExportSnapshot(db: Database.Database, expectedRevision?: number) {
  const snapshot = readProfileStateSnapshot(db)
  if (expectedRevision !== undefined && snapshot.revision !== expectedRevision) {
    throw new ProfileStateRevisionConflictError(expectedRevision, snapshot.revision)
  }
  return snapshot
}

/** Publish a durable JSON rollback/compatibility export without changing authority. */
export function writeProfileStateAuthorityJsonExport(
  db: Database.Database,
  targetPath: string,
  expectedRevision?: number
): number {
  const snapshot = readExportSnapshot(db, expectedRevision)
  mkdirSync(dirname(targetPath), { recursive: true })
  writeFileDurableSync(durableWriteTempPath(targetPath), targetPath, snapshot.json)
  return snapshot.revision
}

/** Stage both accepted versions before replacing canonical JSON for an older build. */
export function writeProfileStateAuthorityCompatibilityExport(
  db: Database.Database,
  targetPath: string,
  expectedRevision?: number
): number | undefined {
  const snapshot = readExportSnapshot(db, expectedRevision)
  if (snapshot.revision === 0) {
    return undefined
  }
  let retained: string | undefined
  try {
    writeCompatibilityRecoveryExport(targetPath, snapshot)
    retained = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : undefined
    mkdirSync(dirname(targetPath), { recursive: true })
  } catch (error) {
    throw new ProfileStateExportPreparationError(error)
  }
  stageProfileStateJsonCompatibility(db, snapshot.json, snapshot.revision, retained)
  writeFileDurableSync(durableWriteTempPath(targetPath), targetPath, snapshot.json)
  acceptProfileStateJsonCompatibility(db, snapshot.json, snapshot.revision)
  return snapshot.revision
}

export async function writeProfileStateAuthorityCompatibilityExportAsync(
  db: Database.Database,
  targetPath: string,
  expectedRevision?: number
): Promise<number | undefined> {
  const snapshot = readExportSnapshot(db, expectedRevision)
  if (snapshot.revision === 0) {
    return undefined
  }
  let retained: string | undefined
  try {
    writeCompatibilityRecoveryExport(targetPath, snapshot)
    retained = await readFile(targetPath, 'utf8').catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return undefined
      }
      throw error
    })
    await mkdir(dirname(targetPath), { recursive: true })
  } catch (error) {
    throw new ProfileStateExportPreparationError(error)
  }
  stageProfileStateJsonCompatibility(db, snapshot.json, snapshot.revision, retained)
  await writeFileDurable(durableWriteTempPath(targetPath), targetPath, snapshot.json)
  acceptProfileStateJsonCompatibility(db, snapshot.json, snapshot.revision)
  return snapshot.revision
}

function writeCompatibilityRecoveryExport(
  dataFile: string,
  snapshot: { json: string; revision: number }
): void {
  writeVersionedProfileStateExport(dataFile, (path) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileDurableSync(durableWriteTempPath(path), path, snapshot.json)
    return snapshot.revision
  })
}
