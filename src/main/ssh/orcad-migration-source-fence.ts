/** Persist journal, fence, then profile flush before remote calls. Crashes may leave a non-authoritative stale journal; a fence without a journal requires destination evidence before release. */
import { randomUUID } from 'node:crypto'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import type { OrcadMigrationBlocker } from '../../shared/orcad-migration/orcad-migration-preflight'
import {
  ORCAD_MIGRATION_SOURCE_CUTOVER_VERSION,
  type OrcadMigrationSourceCutover
} from '../../shared/orcad-migration/orcad-migration-source-cutover'
import type { SshTarget } from '../../shared/ssh-types'
import {
  assertOrcadMigrationRequestFits,
  createOrcadMigrationManifest
} from './orcad-migration-manifest-export'
import {
  findOrcadMigrationSourceCutoverForTarget,
  removeOrcadMigrationSourceCutover,
  writeOrcadMigrationSourceCutover
} from './orcad-migration-cutover-journal'
import {
  confirmOrcadMigrationTerminalsUnderFence,
  type OrcadMigrationTerminalVerdict
} from './orcad-migration-terminal-gate'
import type { SshTargetOrcadClaims } from './targets/ssh-target-orcad-claims'
import {
  isBlockingOrcadMigrationBlocker,
  preflightOrcadMigrationExport,
  type OrcadMigrationPreflightStore
} from './targets/ssh-target-orcad-preflight'
import { orcadMigrationRefusalReason } from './orcad-migration-refusal-reason'
import {
  preservesOrcadMigrationBridgedPanes,
  type OrcadMigrationPaneLeasePredicate
} from './orcad-migration-bridged-panes'

export const ORCAD_MIGRATION_LEAVE_BEHIND_TERMINALS = 'orcad_migration_leave_behind_terminals'
export const ORCAD_MIGRATION_LEAVE_BEHIND_TERMINALS_REASON =
  'Move anyway needs every terminal on this host closed first, and Orca could not confirm they all exited. Close them, or end them on the host, then connect again.'

export type OrcadMigrationFenceState =
  | { state: 'none' }
  | { state: 'fenced'; cutover: OrcadMigrationSourceCutover }
  /** Empty-host deploys record provisioning intent instead of a migration journal. */
  | { state: 'owned-by-deploy'; environmentId: string }
  /** Unexplained ownership requires recovery, never automatic release. */
  | { state: 'fenced-unverifiable'; environmentId: string }
  /** Stale journals grant no staging authority. */
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
  terminalProof: OrcadMigrationTerminalVerdict
  isBridgedPaneLease?: OrcadMigrationPaneLeasePredicate
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
  const proof = args.terminalProof
  if (proof.verdict !== 'exited' && proof.verdict !== 'bridged') {
    return refuse(proof.verdict, 'orcad_migration_terminals', proof.reason)
  }
  const preflight = preflightOrcadMigrationExport(
    args.store,
    target.id,
    undefined,
    proof.verdict === 'bridged' ? proof.bridgedPtyIds : []
  )
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
  if (
    proof.verdict === 'bridged' &&
    target.managedServerLeaveBehind &&
    !preservesOrcadMigrationBridgedPanes(
      manifest.payload,
      args.store.getSshRemotePtyLeases(target.id),
      proof.bridgedPtyIds,
      args.isBridgedPaneLease
    )
  ) {
    return refuse(
      proof.relayVerdict,
      ORCAD_MIGRATION_LEAVE_BEHIND_TERMINALS,
      ORCAD_MIGRATION_LEAVE_BEHIND_TERMINALS_REASON
    )
  }
  // Reject before journaling so an unsendable manifest cannot pin the fence.
  assertOrcadMigrationRequestFits({ manifest })
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
    provenPtyIds: proof.verdict === 'exited' ? proof.provenPtyIds : [],
    ...(proof.verdict === 'bridged' ? { bridgedPtyIds: proof.bridgedPtyIds } : {}),
    // Capture before commit; this journaled export is the evidence of what the destination receives.
    manifest
  }
  writeOrcadMigrationSourceCutover(args.userDataPath, cutover)
  args.claims.fenceForMigration(target.id, args.destinationEnvironmentId, generation)
  await args.claims.flush(args.signal)
  // Recheck under fence for terminals started after the original proof.
  const underFence = confirmOrcadMigrationTerminalsUnderFence(
    args.store,
    target.id,
    args.terminalProof
  )
  if (underFence.verdict !== 'exited' && underFence.verdict !== 'bridged') {
    await releaseUnstagedFence(args, cutover)
    return refuse(underFence.verdict, 'orcad_migration_terminals', underFence.reason)
  }
  return { outcome: 'fenced', cutover, resumed: false }
}

type FenceReleaseArgs = { userDataPath: string; claims: SshTargetOrcadClaims; signal?: AbortSignal }

async function releaseUnstagedFence(
  args: FenceReleaseArgs,
  cutover: OrcadMigrationSourceCutover
): Promise<void> {
  if (cutover.phase !== 'source-fenced') {
    throw new Error('orcad_migration_fence_release_after_stage')
  }
  await releaseOrcadMigrationFence(args, cutover)
}

/** Drop owner before journal so an interrupted release leaves a harmless stale journal, never unexplained ownership. */
export async function releaseOrcadMigrationFence(
  args: FenceReleaseArgs,
  cutover: OrcadMigrationSourceCutover
): Promise<void> {
  args.claims.release(cutover.sshTargetId, cutover.destinationEnvironmentId)
  await args.claims.flush(args.signal)
  removeOrcadMigrationSourceCutover(args.userDataPath, cutover.migrationId)
}

/** Unregistered destinations could stage nothing; registered destinations must prove durable abort instead. */
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
      return 'Orca already runs on this SSH host.'
    case 'fenced-unverifiable':
      return 'This SSH host is held for a migration whose record is missing. Recover it from this host’s Orca server first.'
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
