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
  writeCompatibilityRecoveryExport(targetPath, snapshot)
  const retained = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : undefined
  stageProfileStateJsonCompatibility(db, snapshot.json, snapshot.revision, retained)
  mkdirSync(dirname(targetPath), { recursive: true })
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
  writeCompatibilityRecoveryExport(targetPath, snapshot)
  const retained = await readFile(targetPath, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined
    }
    throw error
  })
  stageProfileStateJsonCompatibility(db, snapshot.json, snapshot.revision, retained)
  await mkdir(dirname(targetPath), { recursive: true })
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
