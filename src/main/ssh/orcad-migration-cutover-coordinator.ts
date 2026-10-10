/**
 * Staging, committing and aborting a dormant migration on its destination orcad.
 *
 * The source stays authoritative until the destination proves a commit: before every stage and
 * commit the fenced source must still export the journaled manifest and carry no state the
 * manifest cannot. A lost answer is never read as success or as absence; the destination's
 * catalog state is re-read, and only that observation moves the journal, which is on disk before
 * anything is returned. A committed destination is never released.
 */
import type {
  OrcadMigrationCatalogAbortResult,
  OrcadMigrationCatalogState,
  OrcadMigrationManifest
} from '../../shared/orcad-migration-manifest'
import type {
  OrcadMigrationSnapshotChunkRequest,
  OrcadMigrationSnapshotChunkResult
} from '../../shared/orcad-migration-scrollback'
import type {
  OrcadMigrationSourceCutover,
  OrcadMigrationSourceCutoverPhase
} from '../../shared/orcad-migration-source-cutover'
import { resolveDurableOrcadCatalogMutation } from './orcad-catalog-durable-mutation'
import { ORCAD_MIGRATION_DESTINATION_UNSUPPORTED } from './orcad-migration-catalog-client'
import {
  listOrcadMigrationSourceCutovers,
  writeOrcadMigrationSourceCutover
} from './orcad-migration-cutover-journal'
import { releaseOrcadMigrationFence } from './orcad-migration-source-fence'
import {
  transferOrcadMigrationSnapshots,
  type OrcadMigrationSnapshotSource
} from './orcad-migration-snapshot-coordinator'
import { assertOrcadMigrationSourceUnchanged } from './orcad-migration-source-assertions'
import type { OrcadMigrationPreflightStore } from './ssh-target-orcad-preflight'
import type { SshTargetOrcadClaims } from './ssh-target-orcad-claims'

/** The destination's catalog operations, served by the T6-9 orcad.migration.* client. */
export type OrcadMigrationDestinationCatalog = {
  readState: (manifest: OrcadMigrationManifest) => Promise<OrcadMigrationCatalogState>
  stage: (manifest: OrcadMigrationManifest) => Promise<OrcadMigrationCatalogState>
  commit: (manifest: OrcadMigrationManifest) => Promise<OrcadMigrationCatalogState>
  abort: (manifest: OrcadMigrationManifest) => Promise<OrcadMigrationCatalogAbortResult>
  stageChunk: (
    request: OrcadMigrationSnapshotChunkRequest
  ) => Promise<OrcadMigrationSnapshotChunkResult>
}

export type OrcadMigrationCutoverContext = {
  userDataPath: string
  store: OrcadMigrationPreflightStore & OrcadMigrationSnapshotSource
  claims: SshTargetOrcadClaims
  destination: OrcadMigrationDestinationCatalog
  /** Rebuilt for every check when `store` is a copy that would never see a later edit. */
  freshSource?: () => OrcadMigrationPreflightStore
  now?: () => Date
}

export async function stageOrcadMigrationDestination(
  context: OrcadMigrationCutoverContext,
  migrationId: string
): Promise<OrcadMigrationSourceCutover> {
  let cutover = requireCutover(context.userDataPath, migrationId)
  if (cutover.phase === 'destination-committed' || cutover.phase === 'source-retired') {
    return cutover
  }
  assertSourceUnchanged(context, cutover)
  const { destination } = context
  const read = await destination.readState(cutover.manifest)
  const state =
    read.state === 'committed'
      ? await confirmDurableCommit(destination, cutover.manifest)
      : await resolveDurableOrcadCatalogMutation(
          () => destination.stage(cutover.manifest),
          () => destination.readState(cutover.manifest),
          (observed) => observed.state !== 'absent'
        )
  cutover = recordObservedState(context, cutover, state)
  if (state.state === 'staged') {
    await transferOrcadMigrationSnapshots({
      source: context.store,
      manifest: cutover.manifest,
      state,
      destination: { readState: destination.readState, stageChunk: destination.stageChunk }
    })
  }
  return cutover
}

export async function commitOrcadMigrationDestination(
  context: OrcadMigrationCutoverContext,
  migrationId: string
): Promise<OrcadMigrationSourceCutover> {
  const staged = await stageOrcadMigrationDestination(context, migrationId)
  if (staged.phase !== 'destination-staged') {
    return staged
  }
  assertSourceUnchanged(context, staged)
  const { destination } = context
  // Why re-read: a lost commit reply may hide a commit that landed; the read decides.
  const state = await resolveDurableOrcadCatalogMutation(
    () => destination.commit(staged.manifest),
    () => destination.readState(staged.manifest),
    (observed) => observed.state === 'committed'
  )
  if (state.state !== 'committed') {
    throw new Error(`orcad_migration_commit_not_committed:${state.state}`)
  }
  return recordObservedState(context, staged, state)
}

export type OrcadMigrationAbortResult =
  | { outcome: 'released'; evidence: 'catalog-absent' | 'destination-unsupported' }
  | { outcome: 'refused'; code: string; reason: string }

/**
 * Releases the source only on proof the destination holds nothing of this migration. `release`
 * defaults to dropping the fence and journal; a delta move keeps the fence instead.
 */
export async function abortOrcadMigrationCutover(
  context: OrcadMigrationCutoverContext,
  migrationId: string,
  release: (cutover: OrcadMigrationSourceCutover) => Promise<void> = (cutover) =>
    releaseOrcadMigrationFence(context, cutover)
): Promise<OrcadMigrationAbortResult> {
  const cutover = requireCutover(context.userDataPath, migrationId)
  if (cutover.phase === 'destination-committed' || cutover.phase === 'source-retired') {
    return committedRefusal()
  }
  const { destination } = context
  let state: OrcadMigrationCatalogState
  try {
    state = await destination.readState(cutover.manifest)
  } catch (error) {
    // Unsupported means nothing could have been staged, but only if nothing ever was.
    if (isDestinationUnsupported(error) && cutover.phase === 'source-fenced') {
      await release(cutover)
      return { outcome: 'released', evidence: 'destination-unsupported' }
    }
    throw error
  }
  if (state.state !== 'committed') {
    state = await abortWithRecovery(destination, cutover.manifest)
  }
  if (state.state === 'committed') {
    recordObservedState(context, cutover, await confirmDurableCommit(destination, cutover.manifest))
    return committedRefusal()
  }
  if (state.state !== 'absent') {
    throw new Error(`orcad_migration_abort_not_absent:${state.state}`)
  }
  await release(cutover)
  return { outcome: 'released', evidence: 'catalog-absent' }
}

/**
 * A committed read may come from memory the server never flushed; only commit()'s acknowledgement,
 * which flushes before it answers, may move the journal to committed.
 */
async function confirmDurableCommit(
  destination: OrcadMigrationDestinationCatalog,
  manifest: OrcadMigrationManifest
): Promise<OrcadMigrationCatalogState> {
  const state = await destination.commit(manifest)
  if (state.state !== 'committed') {
    throw new Error(`orcad_migration_commit_not_committed:${state.state}`)
  }
  return state
}

function assertSourceUnchanged(
  context: OrcadMigrationCutoverContext,
  cutover: OrcadMigrationSourceCutover
): void {
  const store = context.freshSource?.() ?? context.store
  assertOrcadMigrationSourceUnchanged({ userDataPath: context.userDataPath, store }, cutover)
}

/** Moves the journal to what the destination reported; durable before it returns. */
function recordObservedState(
  context: OrcadMigrationCutoverContext,
  cutover: OrcadMigrationSourceCutover,
  state: OrcadMigrationCatalogState
): OrcadMigrationSourceCutover {
  if (state.state === 'absent') {
    throw new Error('orcad_migration_destination_catalog_absent')
  }
  if (
    state.migrationId !== cutover.migrationId ||
    state.manifestSha256 !== cutover.manifestSha256
  ) {
    throw new Error('orcad_migration_destination_state_mismatch')
  }
  if (
    state.state === 'committed' &&
    (state.receipt.migrationId !== cutover.migrationId ||
      state.receipt.manifestSha256 !== cutover.manifestSha256)
  ) {
    throw new Error('orcad_migration_destination_receipt_mismatch')
  }
  const phase: OrcadMigrationSourceCutoverPhase =
    state.state === 'committed' ? 'destination-committed' : 'destination-staged'
  if (phase === cutover.phase) {
    return cutover
  }
  if (cutover.phase === 'destination-committed' || cutover.phase === 'source-retired') {
    // Why: a journal never moves back from a proven commit.
    return cutover
  }
  const next: OrcadMigrationSourceCutover = {
    ...cutover,
    phase,
    updatedAt: (context.now ?? (() => new Date()))().toISOString()
  }
  writeOrcadMigrationSourceCutover(context.userDataPath, next)
  return next
}

async function abortWithRecovery(
  destination: OrcadMigrationDestinationCatalog,
  manifest: OrcadMigrationManifest
): Promise<OrcadMigrationCatalogState> {
  try {
    return await destination.abort(manifest)
  } catch (abortError) {
    try {
      const observed = await destination.readState(manifest)
      if (observed.state === 'committed') {
        return observed
      }
      if (observed.state === 'absent') {
        // An absent read may predate the flush; a repeated abort proves it durable.
        return await destination.abort(manifest)
      }
    } catch {
      // Still unverifiable: keep the first failure and the fence.
    }
    throw abortError
  }
}

function requireCutover(userDataPath: string, migrationId: string): OrcadMigrationSourceCutover {
  const cutover = listOrcadMigrationSourceCutovers(userDataPath).find(
    (entry) => entry.migrationId === migrationId
  )
  if (!cutover) {
    throw new Error('orcad_migration_source_cutover_not_found')
  }
  return cutover
}

function committedRefusal(): OrcadMigrationAbortResult {
  return {
    outcome: 'refused',
    code: 'orcad_migration_committed_source_cannot_be_released',
    reason: 'The managed server already holds this migration; it can only move forward.'
  }
}

function isDestinationUnsupported(error: unknown): boolean {
  return error instanceof Error && error.message === ORCAD_MIGRATION_DESTINATION_UNSUPPORTED
}
