import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, join } from 'node:path'
import { bestEffortFsyncDirectorySync, fsyncFileSync } from '../../shared/secure-file'
import { hashProfileStateJson } from '../persistence/profile-state/profile-state-documents'
import { isRecord } from '../persistence/profile-state/profile-state-document-validation'
import {
  readProfileStateWithRevision,
  writeSerializedProfileState,
  type ReadProfileStateResult
} from './profile-project-state-file'
import { getOrcaProfileMoveIntentDirectory } from './profile-storage-paths'
import {
  readProfileProjectDomainMoveState,
  validateProfileProjectDomainMoveIntent,
  type ProfileProjectDomainMoveIntent
} from './profile-project-domain-move-intent'
import { writeProfileProjectDomainChanges } from './profile-project-domain-state'

const PROFILE_MOVE_INTENT_VERSION = 1
const INTENT_FILE_PATTERN = /^[0-9a-f-]{36}\.json$/
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export type ProfileProjectMoveIdentity = {
  id: string
  sourceProfileId: string
  targetProfileId: string
}

type ProfileProjectMoveIntentV1 = ProfileProjectMoveIdentity & {
  version: typeof PROFILE_MOVE_INTENT_VERSION
  expectedSourceRevision: number
  expectedTargetRevision: number
  sourceBeforeHash: string
  targetBeforeHash: string
  sourceAfterHash: string
  targetAfterHash: string
  sourceAfterJson: string
  targetAfterJson: string
}

export type ProfileProjectMoveIntent = ProfileProjectMoveIntentV1 | ProfileProjectDomainMoveIntent

export function persistProfileProjectMoveIntent(
  userDataPath: string,
  intent: ProfileProjectMoveIntent
): void {
  validateIntent(intent)
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

export function recoverPendingProfileProjectMoves(userDataPath: string): number {
  const intents = readPendingProfileProjectMoveIntents(userDataPath)
  for (const intent of intents) {
    recoverProfileProjectMoveIntent(userDataPath, intent)
  }
  return intents.length
}

export function profileHasPendingProjectMove(profileId: string, userDataPath: string): boolean {
  try {
    return readPendingProfileProjectMoveIntents(userDataPath).some(
      (intent) => intent.sourceProfileId === profileId || intent.targetProfileId === profileId
    )
  } catch {
    // An unreadable intent cannot rule this profile out as a participant.
    return true
  }
}

function readPendingProfileProjectMoveIntents(userDataPath: string): ProfileProjectMoveIntent[] {
  const directory = getOrcaProfileMoveIntentDirectory(userDataPath)
  return existsSync(directory)
    ? readdirSync(directory)
        .filter((file) => INTENT_FILE_PATTERN.test(file))
        .map((file) => readProfileProjectMoveIntent(join(directory, file)))
    : []
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

function profileProjectMoveIntentPath(userDataPath: string, intentId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(intentId)) {
    throw new Error('Invalid profile move intent ID')
  }
  return join(getOrcaProfileMoveIntentDirectory(userDataPath), `${intentId}.json`)
}

function readProfileProjectMoveIntent(path: string): ProfileProjectMoveIntent {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(
      `Profile move intent is unreadable: ${path}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!isRecord(parsed)) {
    throw new Error(`Profile move intent is malformed: ${path}`)
  }
  validateIntent(parsed)
  if (basename(path) !== `${parsed.id}.json`) {
    throw new Error(`Profile move intent ID does not match its file: ${path}`)
  }
  return parsed
}

function validateIntent(value: unknown): asserts value is ProfileProjectMoveIntent {
  validateMoveIdentity(value)
  if (value.version === 2) {
    validateProfileProjectDomainMoveIntent(value)
    return
  }
  const intent = value
  const expectedSourceRevision = intent.expectedSourceRevision
  const expectedTargetRevision = intent.expectedTargetRevision
  if (
    intent.version !== PROFILE_MOVE_INTENT_VERSION ||
    !Number.isSafeInteger(expectedSourceRevision) ||
    !Number.isSafeInteger(expectedTargetRevision) ||
    typeof expectedSourceRevision !== 'number' ||
    typeof expectedTargetRevision !== 'number' ||
    expectedSourceRevision < 0 ||
    expectedTargetRevision < 0 ||
    !isHash(intent.sourceBeforeHash) ||
    !isHash(intent.targetBeforeHash) ||
    !isHash(intent.sourceAfterHash) ||
    !isHash(intent.targetAfterHash) ||
    typeof intent.sourceAfterJson !== 'string' ||
    typeof intent.targetAfterJson !== 'string' ||
    hashProfileStateJson(intent.sourceAfterJson) !== intent.sourceAfterHash ||
    hashProfileStateJson(intent.targetAfterJson) !== intent.targetAfterHash
  ) {
    throw new Error('Profile move intent is malformed')
  }
}

function validateMoveIdentity(
  value: unknown
): asserts value is ProfileProjectMoveIdentity & Record<string, unknown> {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(value.id) ||
    typeof value.sourceProfileId !== 'string' ||
    typeof value.targetProfileId !== 'string' ||
    !PROFILE_ID_PATTERN.test(value.sourceProfileId) ||
    !PROFILE_ID_PATTERN.test(value.targetProfileId) ||
    value.sourceProfileId === value.targetProfileId
  ) {
    throw new Error('Profile move intent is malformed')
  }
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}
