/**
 * The delta move: a fresh, journaled conversion of only what an older build added to a converted
 * host, committed to the same managed server. Its journal supersedes the previous head of the
 * host's chain; both stay, and the source rows of every manifest in the chain are kept.
 *
 * A row the server already holds under another identity fails the whole move at stage, before
 * anything is committed: the journal goes, and the host keeps its "changed" mark and the relay.
 * A move whose outcome the server can't confirm keeps its journal, and the next move resumes it.
 */
import {
  ORCAD_MIGRATION_SOURCE_CUTOVER_VERSION,
  type OrcadMigrationSourceCutover
} from '../../shared/orcad-migration-source-cutover'
import type { OrcadDeltaMoveResult } from '../../shared/orcad-managed-runtime'
import { recordManagedOrcadMigration } from '../../shared/runtime-environment-managed-orcad-store'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { SshTarget } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import {
  abortOrcadMigrationCutover,
  commitOrcadMigrationDestination,
  type OrcadMigrationCutoverContext,
  type OrcadMigrationDestinationCatalog
} from './orcad-migration-cutover-coordinator'
import {
  findOrcadMigrationSourceCutoverForTarget,
  listOrcadMigrationCutoverChainForTarget,
  removeOrcadMigrationSourceCutover,
  writeOrcadMigrationSourceCutover
} from './orcad-migration-cutover-journal'
import {
  committedOrcadMigrationChain,
  orcadDeltaSourceStore,
  planOrcadDeltaMove,
  unfinishedOrcadDelta,
  type OrcadDeltaMovePlan
} from './orcad-migration-delta-plan'
import { retainOrcadMigrationSource } from './orcad-migration-source-retention'
import {
  assessOrcadMigrationTerminals,
  retireProvenExitedLeases,
  type CensusHostRelayTerminals,
  type ListRelayPtyIds
} from './orcad-migration-terminal-gate'
import { currentOrcadSourceFingerprint } from './orcad-retained-source'
import type { SshTargetOrcadClaims } from './ssh-target-orcad-claims'
import { orcadMigrationRefusalReason } from './orcad-migration-refusal-reason'
import { errorMessage } from '../../shared/error-message'

export type OrcadDeltaMoveArgs = {
  userDataPath: string
  store: Store
  claims: SshTargetOrcadClaims
  target: SshTarget
  environment: KnownRuntimeEnvironment
  destination: OrcadMigrationDestinationCatalog
  listRelayPtyIds: ListRelayPtyIds | null
  /** With no relay session to ask, the census of the host's relay endpoints that must prove exit. */
  censusHost?: CensusHostRelayTerminals | null
  /** Releases the relay session after the terminal check, as a conversion does. */
  releaseDirectSession: (sshTargetId: string) => Promise<void>
  ensureTunnel: () => Promise<void>
  /** Serializes the journal write through the commit with every other change to this host. */
  runTargetLifecycle: <T>(targetId: string, operation: () => Promise<T>) => Promise<T>
  now?: () => Date
}

export async function runOrcadDeltaMove(args: OrcadDeltaMoveArgs): Promise<OrcadDeltaMoveResult> {
  const { userDataPath, store, target } = args
  const now = args.now ?? (() => new Date())
  const plan = planOrcadDeltaMove(userDataPath, store, target, { now })
  // Taken with the manifest, before any await: the baseline must describe what the server receives.
  const planned = currentOrcadSourceFingerprint(store, target)
  if (!plan.resumes && plan.added.length === 0) {
    return refuse('orcad_delta_nothing_new', 'An older build added nothing new to move.')
  }
  if (plan.blockers.length > 0) {
    return {
      ...refuse('orcad_migration_preflight_blocked', orcadMigrationRefusalReason(plan.blockers)),
      blockers: plan.blockers
    }
  }
  const terminals = await assessOrcadMigrationTerminals(
    store,
    target.id,
    args.listRelayPtyIds,
    args.censusHost
  )
  if (terminals.verdict !== 'exited') {
    return refuse('orcad_migration_terminals', terminals.reason)
  }
  retireProvenExitedLeases(store, target.id, terminals)
  await args.releaseDirectSession(target.id)
  return args.runTargetLifecycle(target.id, async () => {
    // Why re-checked: another move of this host may have journaled or finished while this waited.
    const changedAt = store.getSshTarget(target.id)?.orcadFence?.sourceChangedAt
    const head = findOrcadMigrationSourceCutoverForTarget(userDataPath, target.id)
    if (!changedAt || head?.migrationId !== (plan.resumes ?? plan.head).migrationId) {
      return refuse('orcad_delta_superseded', 'Another move of this host ran first.')
    }
    // The source stays writable until the fence below: a draft typed while the terminals were
    // checked is newer than the manifest, so it must not become the baseline the server is held to.
    if (!plan.resumes && planned !== currentOrcadSourceFingerprint(store, target)) {
      return refuse(
        'orcad_delta_source_changed',
        'This host changed while the move was starting. Try the move again.'
      )
    }
    const cutover = plan.resumes ?? journalDelta(args, plan, planned, terminals.provenPtyIds, now)
    return commitDelta(args, plan, cutover, changedAt, now)
  })
}

function journalDelta(
  args: OrcadDeltaMoveArgs,
  plan: OrcadDeltaMovePlan,
  planned: string,
  provenPtyIds: string[],
  now: () => Date
): OrcadMigrationSourceCutover {
  const timestamp = now().toISOString()
  const cutover: OrcadMigrationSourceCutover = {
    version: ORCAD_MIGRATION_SOURCE_CUTOVER_VERSION,
    migrationId: plan.manifest.migrationId,
    phase: 'source-fenced',
    startedAt: timestamp,
    updatedAt: timestamp,
    destinationEnvironmentId: plan.environmentId,
    destinationName: plan.head.destinationName,
    sshTargetId: args.target.id,
    sshTargetGeneration: plan.head.sshTargetGeneration,
    manifestSha256: plan.manifest.manifestSha256,
    provenPtyIds,
    supersedesMigrationId: plan.head.migrationId,
    // The whole source as the manifest saw it: what the retained rows must keep matching.
    sourceBaselineFingerprint: planned,
    manifest: plan.manifest
  }
  writeOrcadMigrationSourceCutover(args.userDataPath, cutover)
  return cutover
}

async function commitDelta(
  args: OrcadDeltaMoveArgs,
  plan: OrcadDeltaMovePlan,
  cutover: OrcadMigrationSourceCutover,
  changedAt: string,
  now: () => Date
): Promise<OrcadDeltaMoveResult> {
  const { userDataPath, store, target } = args
  // The fence goes back without its "changed" mark: the source freezes for the move.
  store.updateSshTarget(target.id, { orcadFence: { environmentId: plan.environmentId } })
  await args.claims.flush()
  const context: OrcadMigrationCutoverContext = {
    userDataPath,
    store: plan.source,
    freshSource: () => orcadDeltaSourceStore(store, target, plan.moved),
    claims: args.claims,
    destination: args.destination,
    now
  }
  // Before any commit can land, resumed ones included: a rollback must not cross this move.
  recordManagedOrcadMigration(userDataPath, plan.environmentId, now().toISOString())
  try {
    await args.ensureTunnel()
    const committed = await commitOrcadMigrationDestination(context, cutover.migrationId)
    if (committed.phase !== 'destination-committed' && committed.phase !== 'source-retired') {
      throw new Error(`orcad_migration_commit_not_proven:${committed.phase}`)
    }
  } catch (error) {
    const released = await releaseUncommittedDelta(args, context, cutover, changedAt)
    if (released === 'released') {
      return refuse('orcad_delta_refused_by_server', errorMessage(error))
    }
    if (released === 'kept') {
      throw error
    }
  }
  retainOrcadMigrationSource(userDataPath, cutover.migrationId, now)
  return { outcome: 'moved', migrationId: cutover.migrationId }
}

/**
 * Undoes a delta only once the server provably holds nothing of it, so no row moves twice. One it
 * may hold stays journaled for the next move to resume; either way the host gets its mark back.
 */
async function releaseUncommittedDelta(
  args: OrcadDeltaMoveArgs,
  context: OrcadMigrationCutoverContext,
  cutover: OrcadMigrationSourceCutover,
  changedAt: string
): Promise<'released' | 'committed' | 'kept'> {
  const restoreMark = async (): Promise<void> => {
    args.store.updateSshTarget(cutover.sshTargetId, {
      orcadFence: { environmentId: cutover.destinationEnvironmentId, sourceChangedAt: changedAt }
    })
    await args.claims.flush()
  }
  try {
    const result = await abortOrcadMigrationCutover(context, cutover.migrationId, async () => {
      // Mark first: a crash before the journal goes leaves a marked host that resumes this delta.
      await restoreMark()
      removeOrcadMigrationSourceCutover(args.userDataPath, cutover.migrationId)
    })
    return result.outcome === 'released' ? 'released' : 'committed'
  } catch {
    await restoreMark()
    return 'kept'
  }
}

/** "Keep the server's version": the older build's changes stay only in the retained profile rows. */
export async function keepOrcadServerVersion(args: {
  userDataPath: string
  store: Store
  claims: SshTargetOrcadClaims
  target: SshTarget
}): Promise<void> {
  const environmentId = args.target.orcadFence?.environmentId
  const chain = listOrcadMigrationCutoverChainForTarget(args.userDataPath, args.target.id)
  if (unfinishedOrcadDelta(chain)) {
    // Its rows may be on the server already; only finishing or undoing the move can say.
    throw new Error('orcad_delta_move_unfinished')
  }
  const head = committedOrcadMigrationChain(chain).at(-1)
  if (!environmentId || !args.target.orcadFence?.sourceChangedAt || !head) {
    throw new Error('orcad_delta_not_changed')
  }
  writeOrcadMigrationSourceCutover(args.userDataPath, {
    ...head,
    // Keeping the server's version is the explicit reconcile: the source as it is now is the baseline.
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
