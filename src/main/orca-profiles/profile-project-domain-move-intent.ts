import { randomUUID } from 'node:crypto'
import type { ProfileProjectDomainMoveIntent } from './profile-project-move-record'
export type { ProfileProjectDomainMoveIntent } from './profile-project-move-record'
import {
  profileProjectDomainDigests,
  profileProjectDomainFingerprint,
  type ProfileProjectDomainChanges
} from './profile-project-domain-changes'
import {
  readProfileProjectTransferState,
  type ReadProfileProjectTransferResult
} from './profile-project-domain-state'

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
