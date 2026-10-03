/**
 * The delta move: a fresh, journaled conversion of only what an older build added to a converted
 * host, committed to the same managed server. Its journal supersedes the previous head of the
 * host's chain; both stay until source retirement, which retires every manifest in the chain.
 *
 * A row the server already holds under another identity fails the whole move at stage, before
 * anything is committed: the journal goes, and the host keeps its "changed" mark and the relay.
 */
import {
  ORCAD_MIGRATION_SOURCE_CUTOVER_VERSION,
  type OrcadMigrationSourceCutover
} from '../../shared/orcad-migration-source-cutover'
import type { OrcadDeltaMoveResult } from '../../shared/orcad-managed-runtime'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { SshTarget } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import {
  commitOrcadMigrationDestination,
  type OrcadMigrationDestinationCatalog
} from './orcad-migration-cutover-coordinator'
import {
  removeOrcadMigrationSourceCutover,
  writeOrcadMigrationSourceCutover
} from './orcad-migration-cutover-journal'
import {
  committedOrcadMigrationChain,
  orcadDeltaSourceStore,
  planOrcadDeltaMove
} from './orcad-migration-delta-plan'
import { retainOrcadMigrationSource } from './orcad-migration-source-retention'
import {
  assessOrcadMigrationTerminals,
  type ListRelayPtyIds
} from './orcad-migration-terminal-gate'
import { currentOrcadSourceFingerprint } from './orcad-retained-source'
import type { SshTargetOrcadClaims } from './ssh-target-orcad-claims'

export type OrcadDeltaMoveArgs = {
  userDataPath: string
  store: Store
  claims: SshTargetOrcadClaims
  target: SshTarget
  environment: KnownRuntimeEnvironment
  destination: OrcadMigrationDestinationCatalog
  listRelayPtyIds: ListRelayPtyIds | null
  /** Releases the relay session after the terminal check, as a conversion does. */
  releaseDirectSession: (sshTargetId: string) => Promise<void>
  ensureTunnel: () => Promise<void>
  now?: () => Date
}

export async function runOrcadDeltaMove(args: OrcadDeltaMoveArgs): Promise<OrcadDeltaMoveResult> {
  const { userDataPath, store, target } = args
  const now = args.now ?? (() => new Date())
  const plan = planOrcadDeltaMove(userDataPath, store, target, { now })
  if (plan.added.length === 0) {
    return refuse('orcad_delta_nothing_new', 'An older build added nothing new to move.')
  }
  if (plan.blockers.length > 0) {
    return {
      ...refuse('orcad_migration_preflight_blocked', 'This SSH host cannot move yet.'),
      blockers: plan.blockers
    }
  }
  const terminals = await assessOrcadMigrationTerminals(store, target.id, args.listRelayPtyIds)
  if (terminals.verdict !== 'exited') {
    return refuse('orcad_migration_terminals', terminals.reason)
  }
  await args.releaseDirectSession(target.id)
  const changedAt = target.orcadFence?.sourceChangedAt
  const timestamp = now().toISOString()
  const head = plan.moved.at(-1)!
  const cutover: OrcadMigrationSourceCutover = {
    version: ORCAD_MIGRATION_SOURCE_CUTOVER_VERSION,
    migrationId: plan.manifest.migrationId,
    phase: 'source-fenced',
    startedAt: timestamp,
    updatedAt: timestamp,
    destinationEnvironmentId: plan.environmentId,
    destinationName: head.destinationName,
    sshTargetId: target.id,
    sshTargetGeneration: head.sshTargetGeneration,
    manifestSha256: plan.manifest.manifestSha256,
    provenPtyIds: terminals.provenPtyIds,
    supersedesMigrationId: head.migrationId,
    // The whole source as it is now: what the retained rows must keep matching afterwards.
    sourceBaselineFingerprint: currentOrcadSourceFingerprint(store, target),
    manifest: plan.manifest
  }
  // Journal first, then the fence back without its "changed" mark: the source freezes for the move.
  writeOrcadMigrationSourceCutover(userDataPath, cutover)
  store.updateSshTarget(target.id, { orcadFence: { environmentId: plan.environmentId } })
  await args.claims.flush()
  try {
    await args.ensureTunnel()
    const committed = await commitOrcadMigrationDestination(
      {
        userDataPath,
        store: orcadDeltaSourceStore(
          store,
          target,
          committedOrcadMigrationChain(userDataPath, target.id)
        ),
        claims: args.claims,
        destination: args.destination,
        now
      },
      cutover.migrationId
    )
    if (committed.phase !== 'destination-committed' && committed.phase !== 'source-retired') {
      throw new Error(`orcad_migration_commit_not_proven:${committed.phase}`)
    }
  } catch (error) {
    if (await releaseUncommittedDelta(args, cutover, changedAt)) {
      return refuse('orcad_delta_refused_by_server', errorMessage(error))
    }
    throw error
  }
  retainOrcadMigrationSource(userDataPath, cutover.migrationId, now)
  return { outcome: 'moved', migrationId: cutover.migrationId }
}

/**
 * Undoes a delta the server never committed: only when the server holds nothing of it, so no
 * row moves twice. A delta it may hold stays journaled for the next attempt to resume.
 */
async function releaseUncommittedDelta(
  args: OrcadDeltaMoveArgs,
  cutover: OrcadMigrationSourceCutover,
  changedAt: string | undefined
): Promise<boolean> {
  let state
  try {
    state = await args.destination.readState(cutover.manifest)
    if (state.state === 'staged') {
      const aborted = await args.destination.abort(cutover.manifest)
      state = aborted
    }
  } catch {
    return false
  }
  if (state.state !== 'absent') {
    return false
  }
  removeOrcadMigrationSourceCutover(args.userDataPath, cutover.migrationId)
  args.store.updateSshTarget(cutover.sshTargetId, {
    orcadFence: {
      environmentId: cutover.destinationEnvironmentId,
      ...(changedAt ? { sourceChangedAt: changedAt } : {})
    }
  })
  await args.claims.flush()
  return true
}

/** "Keep the server's version": the older build's changes stay only in the retained profile rows. */
export async function keepOrcadServerVersion(args: {
  userDataPath: string
  store: Store
  claims: SshTargetOrcadClaims
  target: SshTarget
}): Promise<void> {
  const environmentId = args.target.orcadFence?.environmentId
  const head = committedOrcadMigrationChain(args.userDataPath, args.target.id).at(-1)
  if (!environmentId || !args.target.orcadFence?.sourceChangedAt || !head) {
    throw new Error('orcad_delta_not_changed')
  }
  writeOrcadMigrationSourceCutover(args.userDataPath, {
    ...head,
    sourceBaselineFingerprint: currentOrcadSourceFingerprint(args.store, args.target)
  })
  args.store.updateSshTarget(args.target.id, { orcadFence: { environmentId } })
  await args.claims.flush()
}

function refuse(
  code: string,
  reason: string
): Extract<OrcadDeltaMoveResult, { outcome: 'refused' }> {
  return { outcome: 'refused', code, reason }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
