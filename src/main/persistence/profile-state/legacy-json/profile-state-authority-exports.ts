import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { durableWriteTempPath, writeFileDurableSync } from '../../../durable-file-write'
import { readProfileStateSnapshot } from '../profile-state-documents'
import {
  stageProfileStateRecoveryJson,
  acceptProfileStateRecoveryJson
} from './profile-state-json-acceptance'
import { writeVersionedProfileStateExport } from './profile-state-versioned-export'
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

/** Explicit recovery republishes accepted JSON; ordinary profile saves never call this. */
export function writeProfileStateRecoveryJsonExport(
  db: Database.Database,
  targetPath: string,
  expectedRevision: number
): number {
  const snapshot = readExportSnapshot(db, expectedRevision)
  writeVersionedProfileStateExport(
    targetPath,
    (path) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileDurableSync(durableWriteTempPath(path), path, snapshot.json)
      return snapshot.revision
    },
    { retainAllExports: true }
  )
  const retained = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : undefined
  stageProfileStateRecoveryJson(db, snapshot.json, snapshot.revision, retained)
  writeFileDurableSync(durableWriteTempPath(targetPath), targetPath, snapshot.json)
  acceptProfileStateRecoveryJson(db, snapshot.json, snapshot.revision)
  return snapshot.revision
}
