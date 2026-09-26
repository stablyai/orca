import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { durableWriteTempPath, writeFileDurableSync } from '../../../durable-file-write'
import { readProfileStateSnapshot } from '../profile-state-documents'
import type Database from '../../../sqlite/sync-database'
import { ProfileStateRevisionConflictError } from '../profile-state-document-validation'

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
