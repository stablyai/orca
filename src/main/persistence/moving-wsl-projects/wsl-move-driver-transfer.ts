/**
 * The host half of a WSL move, from `quiesced` to `destination-committed`: stage the catalog, send
 * the scrollback snapshots and blobs, then ask for the commit. Each step is journaled before the
 * next starts, and the commit is requested only from `blobs-transferred` (#29825's contract).
 */
import type { OrcadMigrationBlobDescriptor } from '../../../shared/orcad-migration/orcad-migration-blob-transfer'
import type { OrcadMigrationCatalogState } from '../../../shared/orcad-migration/orcad-migration-manifest'
import type { WslMoveCutover, WslMoveCutoverPhase } from '../../../shared/wsl-move/wsl-move-cutover'
import {
  transferOrcadMigrationBlobs,
  type OrcadMigrationBlobSource
} from '../../ssh/orcad-migration-blob-coordinator'
import { resolveDurableOrcadCatalogMutation } from '../../ssh/orcad-catalog-durable-mutation'
import { transferOrcadMigrationSnapshots } from '../../ssh/orcad-migration-snapshot-coordinator'
import { writeWslMoveCutover } from './wsl-move-cutover-journal'
import type { WslMoveDriverDeps, WslMoveHost, WslMoveManifestExport } from './wsl-move-driver-ports'
import { assertWslMoveCommitRequestAllowed } from './wsl-move-reset'
import { buildWslMoveRestoreHintsBlob } from './wsl-move-restore-hints-blob'

type TransferDeps = Pick<WslMoveDriverDeps, 'userDataPath' | 'snapshots' | 'shellHistory' | 'now'>

/** One phase forward through the journal's compare-and-swap; durable before it returns. */
export function advanceWslMove(
  deps: Pick<WslMoveDriverDeps, 'userDataPath' | 'now'>,
  cutover: WslMoveCutover,
  phase: WslMoveCutoverPhase
): WslMoveCutover {
  const next: WslMoveCutover = { ...cutover, phase, updatedAt: deps.now().toISOString() }
  writeWslMoveCutover(deps.userDataPath, next)
  return next
}

export async function stageWslMove(
  deps: TransferDeps,
  host: WslMoveHost,
  quiesced: WslMoveCutover
): Promise<WslMoveCutover> {
  const { catalog } = host
  const state = await resolveDurableOrcadCatalogMutation(
    () => catalog.stage(quiesced.manifest),
    () => catalog.readState(quiesced.manifest),
    (observed) => observed.state !== 'absent'
  )
  // Nothing asked for a commit yet, so anything but a stage of this manifest is not ours.
  if (state.state !== 'staged') {
    throw new Error(`wsl_move_stage_not_staged:${state.state}`)
  }
  assertSameMigration(quiesced, state)
  const staged = advanceWslMove(deps, quiesced, 'destination-staged')
  await transferOrcadMigrationSnapshots({
    source: deps.snapshots,
    manifest: staged.manifest,
    state,
    destination: { readState: catalog.readState, stageChunk: catalog.stageChunk }
  })
  return staged
}

/** Restore hints come from the journal record, so what is sent is what a crash kept. */
export async function collectWslMoveBlobs(
  deps: TransferDeps,
  cutover: WslMoveCutover,
  worktrees: WslMoveManifestExport['worktrees']
): Promise<{ descriptors: OrcadMigrationBlobDescriptor[]; source: OrcadMigrationBlobSource }> {
  const hints = buildWslMoveRestoreHintsBlob(cutover.terminalRestoreHints ?? [])
  const history = await deps.shellHistory(cutover.manifest.source.distro, worktrees)
  const descriptors = [...(hints ? [hints.descriptor] : []), ...history.descriptors]
  return {
    descriptors,
    source: {
      readChunk: (descriptor, offset, maxBytes) =>
        descriptor.blobKind === 'terminal-restore-hints' && hints
          ? hints.source.readChunk(descriptor, offset, maxBytes)
          : history.source.readChunk(descriptor, offset, maxBytes)
    }
  }
}

export async function sendWslMoveBlobs(
  deps: TransferDeps,
  host: WslMoveHost,
  staged: WslMoveCutover,
  blobs: Awaited<ReturnType<typeof collectWslMoveBlobs>>
): Promise<WslMoveCutover> {
  await transferOrcadMigrationBlobs({
    source: blobs.source,
    manifest: staged.manifest,
    blobs: blobs.descriptors,
    destination: {
      readCapabilities: async () => host.capabilities,
      readState: host.catalog.readState,
      stageChunk: host.blobs.stageChunk
    }
  })
  return advanceWslMove(deps, staged, 'blobs-transferred')
}

/**
 * Only an acknowledged commit moves the journal. A lost reply throws: the caller's reset asks the
 * host, and records the commit from its acknowledgement if it landed.
 */
export async function commitWslMove(
  deps: TransferDeps,
  host: WslMoveHost,
  transferred: WslMoveCutover,
  expectedBlobs: readonly OrcadMigrationBlobDescriptor[]
): Promise<WslMoveCutover> {
  assertWslMoveCommitRequestAllowed(transferred)
  const state = await host.commitWithBlobs(transferred.manifest, expectedBlobs)
  if (state.state !== 'committed') {
    throw new Error(`wsl_move_commit_not_committed:${state.state}`)
  }
  assertSameMigration(transferred, state)
  if (
    state.receipt.migrationId !== transferred.migrationId ||
    state.receipt.manifestSha256 !== transferred.manifestSha256
  ) {
    throw new Error('wsl_move_destination_receipt_mismatch')
  }
  return advanceWslMove(deps, transferred, 'destination-committed')
}

function assertSameMigration(cutover: WslMoveCutover, state: OrcadMigrationCatalogState): void {
  if (
    state.migrationId !== cutover.migrationId ||
    state.manifestSha256 !== cutover.manifestSha256
  ) {
    throw new Error('wsl_move_destination_state_mismatch')
  }
}
