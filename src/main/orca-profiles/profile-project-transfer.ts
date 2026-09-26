import type {
  TransferOrcaProfileProjectArgs,
  TransferOrcaProfileProjectResult
} from '../../shared/orca-profiles'
import { getOrcaProfileListState } from './profile-index-store'
import { writeSerializedProfileState } from './profile-project-state-file'
import {
  readProfileProjectTransferState,
  writeProfileProjectDomainChanges
} from './profile-project-domain-state'
import { prepareProfileProjectDomainChanges } from './profile-project-domain-changes'
import { createProfileProjectDomainMoveIntent } from './profile-project-domain-move-intent'
import { removeSourceRepo } from './profile-project-source-removal'
import {
  applyPayloadToTarget,
  createTargetRepo,
  createTransferPayload
} from './profile-project-transfer-payload'
import { repoPhysicalKey } from './profile-project-worktree-identity'
import { migrateProfileProjectTransferParticipant } from './profile-project-transfer-migration'
import {
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
  let sourceSnapshot = readProfileProjectTransferState(args.sourceProfileId, userDataPath)
  let targetSnapshot = readProfileProjectTransferState(args.targetProfileId, userDataPath)
  const sourceRepo = sourceSnapshot.state.repos.find((repo) => repo.id === args.repoId)
  if (!sourceRepo) {
    throw new Error('unknown_source_repo')
  }
  const duplicate = targetSnapshot.state.repos.find(
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

  const sourceState = sourceSnapshot.state
  const targetState = targetSnapshot.state
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
  const targetChanges =
    targetSnapshot.documents !== undefined && targetSnapshot.revision !== undefined
      ? prepareProfileProjectDomainChanges(
          targetSnapshot.revision,
          targetSnapshot.documents,
          targetAfterState
        )
      : undefined
  const sourceChanges =
    sourceAfterState !== undefined &&
    sourceSnapshot.documents !== undefined &&
    sourceSnapshot.revision !== undefined
      ? prepareProfileProjectDomainChanges(
          sourceSnapshot.revision,
          sourceSnapshot.documents,
          sourceAfterState
        )
      : undefined
  if (sourceChanges !== undefined) {
    if (targetChanges === undefined) {
      throw new Error('SQLite profile move requires two SQLite participants')
    }
    moveIntent = createProfileProjectDomainMoveIntent({
      sourceProfileId: args.sourceProfileId,
      targetProfileId: args.targetProfileId,
      source: sourceChanges,
      target: targetChanges
    })
    persistProfileProjectMoveIntent(userDataPath, moveIntent)
  }
  if (targetChanges !== undefined) {
    writeProfileProjectDomainChanges(args.targetProfileId, userDataPath, targetChanges)
  } else {
    writeSerializedProfileState(
      args.targetProfileId,
      userDataPath,
      JSON.stringify(targetAfterState)
    )
  }
  if (sourceAfterState !== undefined) {
    if (sourceChanges !== undefined) {
      writeProfileProjectDomainChanges(args.sourceProfileId, userDataPath, sourceChanges)
    } else {
      writeSerializedProfileState(
        args.sourceProfileId,
        userDataPath,
        JSON.stringify(sourceAfterState)
      )
    }
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
