/** Keep source authority until durable destination commit. Verify the fenced export before stage/commit; resolve lost replies by catalog reads and persist journal transitions before returning. Never release a committed destination. */
import type {
  OrcadMigrationCatalogAbortResult,
  OrcadMigrationCatalogReference,
  OrcadMigrationCatalogReferenceAbortResult,
  OrcadMigrationCatalogState,
  OrcadMigrationManifest
} from '../../shared/orcad-migration/orcad-migration-manifest'
import type {
  OrcadMigrationSnapshotChunkRequest,
  OrcadMigrationSnapshotChunkResult
} from '../../shared/orcad-migration/orcad-migration-scrollback'
import type {
  OrcadMigrationSourceCutover,
  OrcadMigrationSourceCutoverPhase
} from '../../shared/orcad-migration/orcad-migration-source-cutover'
import { resolveDurableOrcadCatalogMutation } from './orcad-catalog-durable-mutation'
import { ORCAD_MIGRATION_DESTINATION_UNSUPPORTED } from './orcad-migration-catalog-client'
import { orcadMigrationRequestFits } from './orcad-migration-manifest-export'
import {
  listOrcadMigrationSourceCutovers,
  writeOrcadMigrationSourceCutover
} from './orcad-migration-cutover-journal'
import type { OrcadMigrationSourceCutoverPort } from './orcad-migration-source'
import {
  transferOrcadMigrationSnapshots,
  type OrcadMigrationSnapshotSource
} from './orcad-migration-snapshot-coordinator'
import type { OrcadMigrationPreflightStore } from './targets/ssh-target-orcad-preflight'
import { sshRelayMigrationCutoverPort } from './orcad-migration-ssh-relay-source'
import type { SshTargetOrcadClaims } from './targets/ssh-target-orcad-claims'

export type OrcadMigrationDestinationCatalog = {
  readState: (manifest: OrcadMigrationManifest) => Promise<OrcadMigrationCatalogState>
  stage: (manifest: OrcadMigrationManifest) => Promise<OrcadMigrationCatalogState>
  commit: (manifest: OrcadMigrationManifest) => Promise<OrcadMigrationCatalogState>
  abort: (manifest: OrcadMigrationManifest) => Promise<OrcadMigrationCatalogAbortResult>
  /** Use identity-only abort when the journal's full manifest cannot fit a request. */
  abortByReference: (
    manifest: OrcadMigrationCatalogReference
  ) => Promise<OrcadMigrationCatalogReferenceAbortResult>
  stageChunk: (
    request: OrcadMigrationSnapshotChunkRequest
  ) => Promise<OrcadMigrationSnapshotChunkResult>
}

export type OrcadMigrationCutoverContext = {
  userDataPath: string
  store: OrcadMigrationPreflightStore & OrcadMigrationSnapshotSource
  claims: SshTargetOrcadClaims
  destination: OrcadMigrationDestinationCatalog
  /** Rebuild copied stores for each check so concurrent edits remain visible. */
  freshSource?: () => OrcadMigrationPreflightStore
  /** The fenced source; defaults to the relay-era SSH target the journal names. */
  source?: OrcadMigrationSourceCutoverPort
  now?: () => Date
}

function cutoverSource(context: OrcadMigrationCutoverContext): OrcadMigrationSourceCutoverPort {
  return context.source ?? sshRelayMigrationCutoverPort(context)
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
  // A lost commit reply may hide success; catalog read decides the next step.
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

/** Release only on proven destination absence; default drops journal/fence, while delta moves retain the fence. */
export async function abortOrcadMigrationCutover(
  context: OrcadMigrationCutoverContext,
  migrationId: string,
  release: (cutover: OrcadMigrationSourceCutover) => Promise<void> = (cutover) =>
    cutoverSource(context).releaseFence(cutover)
): Promise<OrcadMigrationAbortResult> {
  const cutover = requireCutover(context.userDataPath, migrationId)
  if (cutover.phase === 'destination-committed' || cutover.phase === 'source-retired') {
    return committedRefusal()
  }
  const { destination } = context
  // Older journals can hold oversized manifests; identity-only abort must still release them.
  if (!orcadMigrationRequestFits({ manifest: cutover.manifest })) {
    const aborted = await destination.abortByReference(cutover.manifest)
    if (aborted.state === 'committed') {
      return committedRefusal()
    }
    await release(cutover)
    return { outcome: 'released', evidence: 'catalog-absent' }
  }
  let state: OrcadMigrationCatalogState
  try {
    state = await destination.readState(cutover.manifest)
  } catch (error) {
    // Unsupported proves absence only before any stage could have landed.
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

/** Committed reads may be unflushed memory; require the idempotent commit acknowledgement to prove durability. */
export async function confirmDurableCommit(
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
  cutoverSource(context).verifyFence(cutover)
}

/** Persist observed state before returning. */
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
    // Never regress a proven commit.
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

/** Aborts staging; a failed abort is decided by a re-read, never assumed. */
export async function abortWithRecovery(
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
        // Absent reads may predate flush; repeat abort to prove durable absence.
        return await destination.abort(manifest)
      }
    } catch {
      // Keep the original failure and fence while abort remains unverifiable.
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
    reason: 'This host’s Orca server already holds this migration; it can only move forward.'
  }
}

function isDestinationUnsupported(error: unknown): boolean {
  return error instanceof Error && error.message === ORCAD_MIGRATION_DESTINATION_UNSUPPORTED
}
