import type {
  TransferOrcaProfileProjectArgs,
  TransferOrcaProfileProjectResult
} from '../../shared/orca-profiles'
import { getOrcaProfileListState } from './profile-index-store'
import { readProfileStateWithRevision, writeProfileState } from './profile-project-state-file'
import { removeSourceRepo } from './profile-project-source-removal'
import {
  applyPayloadToTarget,
  createTargetRepo,
  createTransferPayload
} from './profile-project-transfer-payload'
import { repoPhysicalKey } from './profile-project-worktree-identity'
import { migrateProfileProjectTransferParticipant } from './profile-project-transfer-migration'
import {
  createProfileProjectMoveIntent,
  persistProfileProjectMoveIntent,
  recoverPendingProfileProjectMoves,
  removeProfileProjectMoveIntent,
  type ProfileProjectMoveIntent
} from './profile-project-move-intent'

function assertKnownProfiles(args: TransferOrcaProfileProjectArgs, userDataPath: string): void {
  const profiles = getOrcaProfileListState(userDataPath).profiles
  const ids = new Set(profiles.map((profile) => profile.id))
  if (!ids.has(args.sourceProfileId)) {
    throw new Error('unknown_source_orca_profile')
  }
  if (!ids.has(args.targetProfileId)) {
    throw new Error('unknown_target_orca_profile')
  }
  if (args.sourceProfileId === args.targetProfileId) {
    throw new Error('matching_orca_profile_transfer')
  }
}

export function transferOrcaProfileProject(
  args: TransferOrcaProfileProjectArgs,
  userDataPath: string
): TransferOrcaProfileProjectResult {
  recoverPendingProfileProjectMoves(userDataPath)
  assertKnownProfiles(args, userDataPath)
  let sourceSnapshot = readProfileStateWithRevision(args.sourceProfileId, userDataPath)
  let targetSnapshot = readProfileStateWithRevision(args.targetProfileId, userDataPath)
  const sourceState = sourceSnapshot.state
  const targetState = targetSnapshot.state
  const sourceRepo = sourceState.repos.find((repo) => repo.id === args.repoId)
  if (!sourceRepo) {
    throw new Error('unknown_source_repo')
  }
  const duplicate = targetState.repos.find(
    (repo) => repoPhysicalKey(repo) === repoPhysicalKey(sourceRepo)
  )
  if (duplicate) {
    return {
      status: 'duplicate-target',
      sourceProfileId: args.sourceProfileId,
      targetProfileId: args.targetProfileId,
      sourceRepoId: sourceRepo.id,
      duplicateRepoId: duplicate.id
    }
  }

  let moveIntent: ProfileProjectMoveIntent | undefined
  if (sourceSnapshot.revision !== undefined && targetSnapshot.revision === undefined) {
    targetSnapshot = migrateProfileProjectTransferParticipant(
      args.targetProfileId,
      userDataPath,
      targetSnapshot
    )
  } else if (
    args.mode === 'move' &&
    sourceSnapshot.revision === undefined &&
    targetSnapshot.revision !== undefined
  ) {
    sourceSnapshot = migrateProfileProjectTransferParticipant(
      args.sourceProfileId,
      userDataPath,
      sourceSnapshot
    )
  }

  const targetRepo = createTargetRepo(sourceRepo, targetState, args.mode === 'copy')
  const payload = createTransferPayload({
    sourceState,
    sourceRepo,
    targetRepo,
    includeSessions: args.mode === 'move'
  })
  const targetAfterState = applyPayloadToTarget(targetState, payload)
  const sourceAfterState =
    args.mode === 'move' ? removeSourceRepo(sourceState, sourceRepo.id) : undefined
  if (sourceAfterState !== undefined && sourceSnapshot.revision !== undefined) {
    moveIntent = createProfileProjectMoveIntent({
      sourceProfileId: args.sourceProfileId,
      targetProfileId: args.targetProfileId,
      source: sourceSnapshot,
      target: targetSnapshot,
      sourceAfterJson: JSON.stringify(sourceAfterState),
      targetAfterJson: JSON.stringify(targetAfterState)
    })
    persistProfileProjectMoveIntent(userDataPath, moveIntent)
  }
  writeProfileState(
    args.targetProfileId,
    userDataPath,
    targetAfterState,
    targetSnapshot.revision === undefined ? {} : { expectedRevision: targetSnapshot.revision }
  )
  if (sourceAfterState !== undefined) {
    writeProfileState(
      args.sourceProfileId,
      userDataPath,
      sourceAfterState,
      sourceSnapshot.revision === undefined ? {} : { expectedRevision: sourceSnapshot.revision }
    )
    if (moveIntent) {
      removeProfileProjectMoveIntent(userDataPath, moveIntent.id)
    }
  }
  return {
    status: 'transferred',
    mode: args.mode,
    sourceProfileId: args.sourceProfileId,
    targetProfileId: args.targetProfileId,
    sourceRepoId: sourceRepo.id,
    targetRepoId: targetRepo.id,
    targetProjectId: payload.targetProjectId
  }
}
