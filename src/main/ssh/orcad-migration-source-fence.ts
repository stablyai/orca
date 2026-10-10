/**
 * Fencing a relay-hosted SSH target for a dormant migration into a managed orcad.
 *
 * Two durable records describe a fence: the journal sidecar and the target's `orcadFence`.
 * Write order is journal, then fence, then the profile flush, all before any remote call, so a
 * crash leaves either nothing, a journal without a fence (stale, never authority), or both.
 * A fence without a journal is never released here: only the destination can say what happened.
 */
import { randomUUID } from 'node:crypto'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import type { OrcadMigrationBlocker } from '../../shared/orcad-migration-preflight'
import {
  ORCAD_MIGRATION_SOURCE_CUTOVER_VERSION,
  type OrcadMigrationSourceCutover
} from '../../shared/orcad-migration-source-cutover'
import type { SshTarget } from '../../shared/ssh-types'
import { createOrcadMigrationManifest } from './orcad-migration-manifest-export'
import {
  findOrcadMigrationSourceCutoverForTarget,
  removeOrcadMigrationSourceCutover,
  writeOrcadMigrationSourceCutover
} from './orcad-migration-cutover-journal'
import {
  confirmOrcadMigrationTerminalsUnderFence,
  type OrcadMigrationTerminalVerdict
} from './orcad-migration-terminal-gate'
import type { SshTargetOrcadClaims } from './ssh-target-orcad-claims'
import {
  isBlockingOrcadMigrationBlocker,
  preflightOrcadMigrationExport,
  type OrcadMigrationPreflightStore
} from './ssh-target-orcad-preflight'
import { orcadMigrationRefusalReason } from './orcad-migration-refusal-reason'

export type OrcadMigrationFenceState =
  | { state: 'none' }
  /** Owner and journal agree: the migration can resume. */
  | { state: 'fenced'; cutover: OrcadMigrationSourceCutover }
  /** Owned by an empty-host deploy, which records itself as a provisioning intent instead. */
  | { state: 'owned-by-deploy'; environmentId: string }
  /** Owner with no journal (a downgrade dropped it, or it never landed): recover, never release. */
  | { state: 'fenced-unverifiable'; environmentId: string }
  /** Journal whose fence is gone or changed: it can never authorize staging. */
  | { state: 'stale-journal'; cutover: OrcadMigrationSourceCutover }

/** Throws when the journal cannot be read: an unreadable record keeps the host fenced. */
export function resolveOrcadMigrationFence(
  userDataPath: string,
  target: SshTarget
): OrcadMigrationFenceState {
  const cutover = findOrcadMigrationSourceCutoverForTarget(userDataPath, target.id)
  const ownerEnvironmentId = getManagedOrcadFenceEnvironmentId(target)
  if (cutover) {
    return ownerEnvironmentId === cutover.destinationEnvironmentId &&
      target.generation === cutover.sshTargetGeneration
      ? { state: 'fenced', cutover }
      : { state: 'stale-journal', cutover }
  }
  if (!ownerEnvironmentId) {
    return { state: 'none' }
  }
  return target.orcadProvisioning
    ? { state: 'owned-by-deploy', environmentId: ownerEnvironmentId }
    : { state: 'fenced-unverifiable', environmentId: ownerEnvironmentId }
}

export type OrcadMigrationFenceResult =
  | { outcome: 'fenced'; cutover: OrcadMigrationSourceCutover; resumed: boolean }
  | {
      outcome: 'refused'
      verdict: 'live' | 'unverifiable'
      code: string
      reason: string
      blockers?: OrcadMigrationBlocker[]
    }

export async function fenceOrcadMigrationSource(args: {
  userDataPath: string
  store: OrcadMigrationPreflightStore
  claims: SshTargetOrcadClaims
  targetId: string
  destinationEnvironmentId: string
  destinationName: string
  /** Taken by the caller while the relay could still answer; see orcad-migration-terminal-gate. */
  terminalProof: OrcadMigrationTerminalVerdict
  hasDirectSshAuthority: (targetId: string) => boolean
  now?: () => Date
  signal?: AbortSignal
}): Promise<OrcadMigrationFenceResult> {
  const target = args.store.getSshTarget(args.targetId)
  if (!target) {
    return refuse('unverifiable', 'orcad_migration_target_not_found', 'The SSH host is gone.')
  }
  const existing = resolveOrcadMigrationFence(args.userDataPath, target)
  if (existing.state === 'fenced') {
    return existing.cutover.destinationEnvironmentId === args.destinationEnvironmentId
      ? { outcome: 'fenced', cutover: existing.cutover, resumed: true }
      : refuse('live', 'orcad_migration_in_progress', 'Another migration holds this SSH host.')
  }
  if (existing.state !== 'none') {
    return refuse(
      'unverifiable',
      `orcad_migration_${existing.state.replaceAll('-', '_')}`,
      fenceStateReason(existing)
    )
  }
  if (args.terminalProof.verdict !== 'exited') {
    return refuse(
      args.terminalProof.verdict,
      'orcad_migration_terminals',
      args.terminalProof.reason
    )
  }
  if (args.hasDirectSshAuthority(target.id)) {
    return refuse('live', 'orcad_migration_direct_ssh_connected', 'Disconnect this SSH host first.')
  }
  const preflight = preflightOrcadMigrationExport(args.store, target.id)
  if (!preflight.claimable) {
    return {
      ...refuse(
        // Only a proven blocker reads live; one that is merely unanswered stays unverifiable.
        preflight.blockers
          .filter(isBlockingOrcadMigrationBlocker)
          .every((blocker) => blocker.category === 'live-or-unverifiable')
          ? 'unverifiable'
          : 'live',
        'orcad_migration_preflight_blocked',
        orcadMigrationRefusalReason(preflight.blockers)
      ),
      blockers: preflight.blockers
    }
  }
  const generation = args.claims.ensureGeneration(target.id)
  const now = (args.now ?? (() => new Date()))().toISOString()
  const manifest = createOrcadMigrationManifest(
    args.store,
    { ...target, generation },
    { migrationId: randomUUID(), destinationEnvironmentId: args.destinationEnvironmentId }
  )
  const cutover: OrcadMigrationSourceCutover = {
    version: ORCAD_MIGRATION_SOURCE_CUTOVER_VERSION,
    migrationId: manifest.migrationId,
    phase: 'source-fenced',
    startedAt: now,
    updatedAt: now,
    destinationEnvironmentId: args.destinationEnvironmentId,
    destinationName: args.destinationName,
    sshTargetId: target.id,
    sshTargetGeneration: generation,
    manifestSha256: manifest.manifestSha256,
    provenPtyIds: args.terminalProof.provenPtyIds,
    // Taken with the export, before any commit is possible: the only proof of what the server holds.
    manifest
  }
  writeOrcadMigrationSourceCutover(args.userDataPath, cutover)
  args.claims.fenceForMigration(target.id, args.destinationEnvironmentId, generation)
  await args.claims.flush(args.signal)
  // Why again: a terminal may have started between the proof and the fence.
  const underFence = confirmOrcadMigrationTerminalsUnderFence(
    args.store,
    target.id,
    args.terminalProof
  )
  if (underFence.verdict !== 'exited') {
    await releaseUnstagedFence(args, cutover)
    return refuse(underFence.verdict, 'orcad_migration_terminals', underFence.reason)
  }
  return { outcome: 'fenced', cutover, resumed: false }
}

type FenceReleaseArgs = { userDataPath: string; claims: SshTargetOrcadClaims; signal?: AbortSignal }

/** Undoes a fence nothing remote has seen. */
export async function releaseUnstagedFence(
  args: FenceReleaseArgs,
  cutover: OrcadMigrationSourceCutover
): Promise<void> {
  if (cutover.phase !== 'source-fenced') {
    throw new Error('orcad_migration_fence_release_after_stage')
  }
  await releaseOrcadMigrationFence(args, cutover)
}

/**
 * Owner first, then the journal: a crash between them leaves a stale journal, which grants
 * nothing, rather than an owner nothing explains.
 */
export async function releaseOrcadMigrationFence(
  args: FenceReleaseArgs,
  cutover: OrcadMigrationSourceCutover
): Promise<void> {
  args.claims.release(cutover.sshTargetId, cutover.destinationEnvironmentId)
  await args.claims.flush(args.signal)
  removeOrcadMigrationSourceCutover(args.userDataPath, cutover.migrationId)
}

/**
 * Releases a migration fence whose destination server was never registered: no deploy finished,
 * so nothing could have been staged there. A registered destination must answer an abort instead.
 */
export async function releaseUndeployedMigrationFence(args: {
  userDataPath: string
  claims: SshTargetOrcadClaims
  targetId: string
  isDestinationRegistered: (environmentId: string) => boolean
  signal?: AbortSignal
}): Promise<'released' | 'none'> {
  const cutover = findOrcadMigrationSourceCutoverForTarget(args.userDataPath, args.targetId)
  if (!cutover) {
    return 'none'
  }
  if (args.isDestinationRegistered(cutover.destinationEnvironmentId)) {
    throw new Error('orcad_migration_destination_registered')
  }
  await releaseUnstagedFence(args, cutover)
  return 'released'
}

function fenceStateReason(state: OrcadMigrationFenceState): string {
  switch (state.state) {
    case 'owned-by-deploy':
      return 'This SSH host already belongs to a managed server.'
    case 'fenced-unverifiable':
      return 'This SSH host is held for a migration whose record is missing. Recover it from the managed server first.'
    case 'stale-journal':
      return 'A migration record names this SSH host but its fence is gone. Resolve that migration first.'
    case 'fenced':
    case 'none':
      return 'This SSH host is not in a state a migration can start from.'
  }
}

function refuse(
  verdict: 'live' | 'unverifiable',
  code: string,
  reason: string
): Extract<OrcadMigrationFenceResult, { outcome: 'refused' }> {
  return { outcome: 'refused', verdict, code, reason }
}
