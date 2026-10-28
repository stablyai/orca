import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { hashProfileStateJson } from '../persistence/profile-state/profile-state-documents'
import { isRecord } from '../persistence/profile-state/profile-state-document-validation'
import { getOrcaProfileMoveIntentDirectory } from './profile-storage-paths'
import {
  validateProfileProjectDomainChanges,
  type ProfileProjectDomainChanges
} from './profile-project-domain-changes'

const PROFILE_MOVE_INTENT_VERSION = 1
const INTENT_FILE_PATTERN = /^[0-9a-f-]{36}\.json$/
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export type ProfileProjectMoveIdentity = {
  id: string
  sourceProfileId: string
  targetProfileId: string
}

export type ProfileProjectMoveIntentV1 = ProfileProjectMoveIdentity & {
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

export type ProfileProjectDomainMoveIntent = ProfileProjectMoveIdentity & {
  version: 2
  source: ProfileProjectDomainChanges
  target: ProfileProjectDomainChanges
}

export type ProfileProjectMoveIntent = ProfileProjectMoveIntentV1 | ProfileProjectDomainMoveIntent

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

export function readPendingProfileProjectMoveIntents(
  userDataPath: string
): ProfileProjectMoveIntent[] {
  const directory = getOrcaProfileMoveIntentDirectory(userDataPath)
  return existsSync(directory)
    ? readdirSync(directory)
        .filter((file) => INTENT_FILE_PATTERN.test(file))
        .map((file) => readProfileProjectMoveIntent(join(directory, file)))
    : []
}

export function profileProjectMoveIntentPath(userDataPath: string, intentId: string): string {
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
  validateProfileProjectMoveIntent(parsed)
  if (basename(path) !== `${parsed.id}.json`) {
    throw new Error(`Profile move intent ID does not match its file: ${path}`)
  }
  return parsed
}

export function validateProfileProjectMoveIntent(
  value: unknown
): asserts value is ProfileProjectMoveIntent {
  validateMoveIdentity(value)
  if (value.version === 2) {
    validateProfileProjectDomainChanges(value.source)
    validateProfileProjectDomainChanges(value.target)
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
