import { randomUUID } from 'node:crypto'
import type { ProfileProjectMoveIdentity } from './profile-project-move-intent'
import {
  profileProjectDomainDigests,
  profileProjectDomainFingerprint,
  validateProfileProjectDomainChanges,
  type ProfileProjectDomainChanges
} from './profile-project-domain-changes'
import {
  readProfileProjectTransferState,
  type ReadProfileProjectTransferResult
} from './profile-project-domain-state'

export type ProfileProjectDomainMoveIntent = ProfileProjectMoveIdentity & {
  version: 2
  source: ProfileProjectDomainChanges
  target: ProfileProjectDomainChanges
}

export function createProfileProjectDomainMoveIntent(args: {
  sourceProfileId: string
  targetProfileId: string
  source: ProfileProjectDomainChanges
  target: ProfileProjectDomainChanges
}): ProfileProjectDomainMoveIntent {
  return { version: 2, id: randomUUID(), ...args }
}

export function readProfileProjectDomainMoveState(
  userDataPath: string,
  intent: ProfileProjectDomainMoveIntent
): { sourceBefore: boolean; sourceAfter: boolean; targetBefore: boolean; targetAfter: boolean } {
  const source = readProfileProjectTransferState(intent.sourceProfileId, userDataPath)
  const target = readProfileProjectTransferState(intent.targetProfileId, userDataPath)
  if (source.documents === undefined || target.documents === undefined) {
    throw new Error(`Profile move ${intent.id} no longer has two SQLite participants`)
  }
  return {
    sourceBefore: matches(
      source,
      intent.source.expectedRevision,
      profileProjectDomainFingerprint(intent.source.before)
    ),
    targetBefore: matches(
      target,
      intent.target.expectedRevision,
      profileProjectDomainFingerprint(intent.target.before)
    ),
    sourceAfter: matches(source, intent.source.expectedRevision + 1, intent.source.afterHash),
    targetAfter: matches(target, intent.target.expectedRevision + 1, intent.target.afterHash)
  }
}

function matches(
  snapshot: ReadProfileProjectTransferResult,
  revision: number,
  hash: string
): boolean {
  return (
    snapshot.revision === revision &&
    snapshot.documents !== undefined &&
    profileProjectDomainFingerprint(profileProjectDomainDigests(snapshot.documents)) === hash
  )
}

export function validateProfileProjectDomainMoveIntent(
  value: ProfileProjectMoveIdentity & Record<string, unknown>
): asserts value is ProfileProjectDomainMoveIntent {
  if (value.version !== 2) {
    throw new Error('Profile move intent is malformed')
  }
  validateProfileProjectDomainChanges(value.source)
  validateProfileProjectDomainChanges(value.target)
}
