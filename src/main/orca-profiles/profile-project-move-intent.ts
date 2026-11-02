import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { bestEffortFsyncDirectorySync, fsyncFileSync } from '../../shared/secure-file'
import { hashProfileStateJson } from '../persistence/profile-state/profile-state-documents'
import {
  readProfileStateWithRevision,
  writeSerializedProfileState,
  type ReadProfileStateResult
} from './profile-project-state-file'
import { getOrcaProfileMoveIntentDirectory } from './profile-storage-paths'
import { readProfileProjectDomainMoveState } from './profile-project-domain-move-intent'
import { writeProfileProjectDomainChanges } from './profile-project-domain-state'
import {
  profileProjectMoveIntentPath,
  readPendingProfileProjectMoveIntents,
  validateProfileProjectMoveIntent,
  type ProfileProjectMoveIntent,
  type ProfileProjectMoveIntentV1
} from './profile-project-move-record'
export { profileHasPendingProjectMove } from './profile-project-move-record'
export type {
  ProfileProjectMoveIdentity,
  ProfileProjectMoveIntent
} from './profile-project-move-record'

export function persistProfileProjectMoveIntent(
  userDataPath: string,
  intent: ProfileProjectMoveIntent
): void {
  validateProfileProjectMoveIntent(intent)
  const directory = getOrcaProfileMoveIntentDirectory(userDataPath)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = profileProjectMoveIntentPath(userDataPath, intent.id)
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporaryPath, JSON.stringify(intent), { encoding: 'utf8', mode: 0o600 })
  fsyncFileSync(temporaryPath)
  renameSync(temporaryPath, path)
  bestEffortFsyncDirectorySync(directory)
}

export function removeProfileProjectMoveIntent(userDataPath: string, intentId: string): void {
  rmSync(profileProjectMoveIntentPath(userDataPath, intentId), { force: true })
  bestEffortFsyncDirectorySync(getOrcaProfileMoveIntentDirectory(userDataPath))
}

export function recoverPendingProfileProjectMoves(
  userDataPath: string,
  profileId?: string
): number {
  const intents = readPendingProfileProjectMoveIntents(userDataPath).filter(
    (intent) =>
      profileId === undefined ||
      intent.sourceProfileId === profileId ||
      intent.targetProfileId === profileId
  )
  for (const intent of intents) {
    recoverProfileProjectMoveIntent(userDataPath, intent)
  }
  return intents.length
}

function recoverProfileProjectMoveIntent(
  userDataPath: string,
  intent: ProfileProjectMoveIntent
): void {
  const { sourceBefore, targetBefore, sourceAfter, targetAfter } =
    intent.version === 2
      ? readProfileProjectDomainMoveState(userDataPath, intent)
      : readLegacyMoveState(userDataPath, intent)

  if (sourceAfter && targetAfter) {
    removeProfileProjectMoveIntent(userDataPath, intent.id)
    return
  }
  if (sourceBefore && targetBefore) {
    removeProfileProjectMoveIntent(userDataPath, intent.id)
    return
  }
  if (sourceBefore && targetAfter) {
    if (intent.version === 2) {
      writeProfileProjectDomainChanges(intent.sourceProfileId, userDataPath, intent.source)
    } else {
      writeSerializedProfileState(intent.sourceProfileId, userDataPath, intent.sourceAfterJson, {
        expectedRevision: intent.expectedSourceRevision
      })
    }
    removeProfileProjectMoveIntent(userDataPath, intent.id)
    return
  }
  if (sourceBefore && !targetAfter && !targetBefore) {
    throw new Error(`Profile move ${intent.id} has an unrecognized target state`)
  }
  if (targetAfter && !sourceAfter) {
    // Preserve the journal when an independent write makes replay unsafe.
    throw new Error(`Profile move ${intent.id} conflicts with a source profile write`)
  }
  if (sourceAfter && targetBefore) {
    throw new Error(`Profile move ${intent.id} has a source commit without its target commit`)
  }
  throw new Error(`Profile move ${intent.id} has an unrecognized participant state`)
}

function readLegacyMoveState(userDataPath: string, intent: ProfileProjectMoveIntentV1) {
  const source = readProfileStateWithRevision(intent.sourceProfileId, userDataPath)
  const target = readProfileStateWithRevision(intent.targetProfileId, userDataPath)
  if (source.revision === undefined || target.revision === undefined) {
    throw new Error(`Profile move ${intent.id} no longer has two SQLite participants`)
  }

  return {
    sourceBefore: matches(source, intent.expectedSourceRevision, intent.sourceBeforeHash),
    targetBefore: matches(target, intent.expectedTargetRevision, intent.targetBeforeHash),
    sourceAfter: matches(source, intent.expectedSourceRevision + 1, intent.sourceAfterHash),
    targetAfter: matches(target, intent.expectedTargetRevision + 1, intent.targetAfterHash)
  }
}

function matches(snapshot: ReadProfileStateResult, revision: number, hash: string): boolean {
  return (
    snapshot.revision === revision &&
    snapshot.serialized !== undefined &&
    hashProfileStateJson(snapshot.serialized) === hash
  )
}
