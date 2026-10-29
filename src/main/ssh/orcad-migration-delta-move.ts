/** Journal only additions made after conversion to the same server; retain the full journal chain and source rows. Stage conflicts leave the changed mark and source intact; uncertain outcomes keep the journal for resume. */
import {
  ORCAD_MIGRATION_SOURCE_CUTOVER_VERSION,
  type OrcadMigrationSourceCutover
} from '../../shared/orcad-migration/orcad-migration-source-cutover'
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
import { assertOrcadMigrationRequestFits } from './orcad-migration-manifest-export'
import { retainOrcadMigrationSource } from './orcad-migration-source-retention'
import {
  assessOrcadMigrationTerminals,
  type OrcadMigrationTerminalVerdict,
  retireProvenExitedLeases,
  type CensusHostRelayTerminals
} from './orcad-migration-terminal-gate'
import {
  currentOrcadSourceFingerprint,
  orcadCatalogFingerprint,
  unmovedOrcadSourceRows,
  withKeptOrcadSourceRows
} from './orcad-retained-source'
import { collectOrcadMigrationSourceCatalog } from '../persistence/migrating-orcad-catalog/orcad-source-catalog'
import type { SshTargetOrcadClaims } from './targets/ssh-target-orcad-claims'
import { orcadMigrationRefusalReason } from './orcad-migration-refusal-reason'
import { errorMessage } from '../../shared/error-message'

type OrcadDeltaMoveArgs = {
  userDataPath: string
  store: Store
  claims: SshTargetOrcadClaims
  target: SshTarget
  environment: KnownRuntimeEnvironment
  /** Build the destination after opening its tunnel: re-pairing during open can replace commit credentials. */
  connectDestination: () => Promise<OrcadMigrationDestinationCatalog>
  /** Host census proves exit or identifies terminals preserved by the legacy bridge. */
  censusHost?: CensusHostRelayTerminals | null
  /** Serialize journal-through-commit with all other lifecycle changes to this host. */
  runTargetLifecycle: <T>(targetId: string, operation: () => Promise<T>) => Promise<T>
  now?: () => Date
}

export async function runOrcadDeltaMove(args: OrcadDeltaMoveArgs): Promise<OrcadDeltaMoveResult> {
  const { userDataPath, store, target } = args
  const now = args.now ?? (() => new Date())
  const plan = planOrcadDeltaMove(userDataPath, store, target, { now })
  // Capture baseline with the manifest before awaiting so both describe the same source.
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
  if (!plan.resumes) {
    // Reject before journaling or an unsendable delta could pin the fence permanently.
    assertOrcadMigrationRequestFits({ manifest: plan.manifest })
  }
  const terminals = await assessOrcadMigrationTerminals(store, target.id, args.censusHost)
  if (terminals.verdict !== 'exited' && terminals.verdict !== 'bridged') {
    return refuse('orcad_migration_terminals', terminals.reason)
  }
  const settled: SettledTerminals = terminals
  retireProvenExitedLeases(store, target.id, terminals)
  return args.runTargetLifecycle(target.id, async () => {
    // Another move may have journaled or finished while waiting for the lifecycle lock.
    const changedAt = store.getSshTarget(target.id)?.orcadFence?.sourceChangedAt
    const head = findOrcadMigrationSourceCutoverForTarget(userDataPath, target.id)
    if (!changedAt || head?.migrationId !== (plan.resumes ?? plan.head).migrationId) {
      return refuse('orcad_delta_superseded', 'Another move of this host ran first.')
    }
    // Source remains writable before fencing; edits during census must not silently become the manifest's baseline.
    if (!plan.resumes && planned !== currentOrcadSourceFingerprint(store, target)) {
      return refuse(
        'orcad_delta_source_changed',
        'This host changed while the move was starting. Try the move again.'
      )
    }
    const cutover = plan.resumes ?? journalDelta(args, plan, planned, settled, now)
    return commitDelta(args, plan, cutover, changedAt, now)
  })
}

type SettledTerminals = Extract<OrcadMigrationTerminalVerdict, { verdict: 'exited' | 'bridged' }>

function journalDelta(
  args: OrcadDeltaMoveArgs,
  plan: OrcadDeltaMovePlan,
  planned: string,
  terminals: SettledTerminals,
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
    provenPtyIds: terminals.verdict === 'exited' ? terminals.provenPtyIds : [],
    // COMPAT(legacy-relay-bridge): a move leaves relay terminals running for the bridge too.
    ...(terminals.verdict === 'bridged' ? { bridgedPtyIds: terminals.bridgedPtyIds } : {}),
    supersedesMigrationId: plan.head.migrationId,
    // Retained rows must match the whole source captured with this manifest.
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
  // Clear the changed mark and freeze source for the move.
  store.updateSshTarget(target.id, { orcadFence: { environmentId: plan.environmentId } })
  await args.claims.flush()
  // Record before any new/resumed commit so rollback cannot cross the migration.
  recordManagedOrcadMigration(userDataPath, plan.environmentId, now().toISOString())
  let destination: OrcadMigrationDestinationCatalog
  try {
    destination = await args.connectDestination()
  } catch (error) {
    // No request reached the server; keep the journal for later resume.
    await restoreChangedMark(args, cutover, changedAt)
    throw error
  }
  const context: OrcadMigrationCutoverContext = {
    userDataPath,
    store: plan.source,
    freshSource: () => orcadDeltaSourceStore(store, target, plan.moved, cutover.manifest),
    claims: args.claims,
    destination,
    now
  }
  try {
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
  await retainOrcadMigrationSource(userDataPath, cutover.migrationId, store, now)
  return { outcome: 'moved', migrationId: cutover.migrationId }
}

/** Release only on proven destination absence; otherwise retain journal for resume. Restore the host's changed mark either way. */
async function releaseUncommittedDelta(
  args: OrcadDeltaMoveArgs,
  context: OrcadMigrationCutoverContext,
  cutover: OrcadMigrationSourceCutover,
  changedAt: string
): Promise<'released' | 'committed' | 'kept'> {
  const restoreMark = (): Promise<void> => restoreChangedMark(args, cutover, changedAt)
  try {
    const result = await abortOrcadMigrationCutover(context, cutover.migrationId, async () => {
      // Restore the mark first so a crash during journal removal leaves a resumable marked host.
      await restoreMark()
      removeOrcadMigrationSourceCutover(args.userDataPath, cutover.migrationId)
    })
    return result.outcome === 'released' ? 'released' : 'committed'
  } catch {
    await restoreMark()
    return 'kept'
  }
}

async function restoreChangedMark(
  args: Pick<OrcadDeltaMoveArgs, 'store' | 'claims'>,
  cutover: OrcadMigrationSourceCutover,
  changedAt: string
): Promise<void> {
  args.store.updateSshTarget(cutover.sshTargetId, {
    orcadFence: { environmentId: cutover.destinationEnvironmentId, sourceChangedAt: changedAt }
  })
  await args.claims.flush()
}

/** Keep older-build changes only in retained profile rows. */
export async function keepOrcadServerVersion(args: {
  userDataPath: string
  store: Store
  claims: SshTargetOrcadClaims
  target: SshTarget
}): Promise<void> {
  const environmentId = args.target.orcadFence?.environmentId
  const chain = listOrcadMigrationCutoverChainForTarget(args.userDataPath, args.target.id)
  if (unfinishedOrcadDelta(chain)) {
    // Unfinished moves may already have copied rows; only commit/abort can decide.
    throw new Error('orcad_delta_move_unfinished')
  }
  const head = committedOrcadMigrationChain(chain).at(-1)
  if (!environmentId || !args.target.orcadFence?.sourceChangedAt || !head) {
    throw new Error('orcad_delta_not_changed')
  }
  const current = collectOrcadMigrationSourceCatalog(args.store, args.target)
  const unmoved = unmovedOrcadSourceRows(current, committedOrcadMigrationChain(chain))
  writeOrcadMigrationSourceCutover(args.userDataPath, {
    ...withKeptOrcadSourceRows(head, unmoved),
    // Explicit reconcile accepts the current retained source as the new baseline.
    sourceBaselineFingerprint: orcadCatalogFingerprint(current)
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
