import { parseOrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import { parseOrcadMigrationTerminalPublications } from '../../shared/orcad-migration-terminal-publications'
import { parseOrcadMigrationCatalogState } from '../../shared/orcad-migration-catalog-state'
import {
  commitRemoteOrcadMigrationCatalog,
  readRemoteOrcadMigrationCatalogState
} from './orcad-migration-catalog-client'
import { resolveDurableOrcadCatalogMutation } from './orcad-catalog-durable-mutation'
import { assertOrcadLiveCutoverCurrent } from './orcad-live-cutover-current'
import { recordOrcadLiveCutoverProgressDurably } from './orcad-live-cutover-progress'
import type { stageOrcadLiveDestination } from './orcad-live-destination-staging'

/** Catalog commit preserves the source fence; it does not authorize source retirement. */
export async function commitOrcadLiveDestination(
  options: Omit<Parameters<typeof stageOrcadLiveDestination>[0], 'remote'> & {
    remote?: {
      read: typeof readRemoteOrcadMigrationCatalogState
      commit: typeof commitRemoteOrcadMigrationCatalog
    }
  }
) {
  let cutover = parseOrcadMigrationSourceCutover(options.cutover)
  if (
    cutover.version !== 2 ||
    (cutover.phase !== 'destination-staged' && cutover.phase !== 'destination-committed')
  ) {
    throw new Error('orcad_live_cutover_phase_observation_required')
  }
  parseOrcadMigrationTerminalPublications(
    cutover.terminalPublications,
    cutover.manifest,
    cutover.liveTerminalBindings!,
    true
  )
  const assertCurrent = () => assertOrcadLiveCutoverCurrent({ ...options, cutover })
  const remote = options.remote ?? {
    read: readRemoteOrcadMigrationCatalogState,
    commit: commitRemoteOrcadMigrationCatalog
  }
  const requestOptions = {
    signal: options.signal,
    expectedRuntimeId: cutover.liveTerminalBindings![0].identity.destinationRuntimeId
  }
  const read = async () => {
    assertCurrent()
    const result = await remote.read(options.pairingCode, cutover.manifest, requestOptions)
    assertCurrent()
    return parseOrcadMigrationCatalogState(result, cutover.manifest)
  }
  let state = await read()
  if (state.state !== 'committed') {
    if (state.state !== 'staged' || cutover.phase !== 'destination-staged') {
      throw new Error('orcad_live_cutover_destination_state_regressed')
    }
    if (state.stagedAt !== cutover.stagedAt) {
      throw new Error('orcad_live_cutover_transition_conflict')
    }
    const snapshots = cutover.manifest.payload.dormantState?.terminalScrollbackSnapshots ?? []
    if (
      snapshots.length > 0 &&
      ((state.snapshotUploads ?? []).length !== snapshots.length ||
        state.snapshotUploads!.some((entry) => entry.receivedBytes !== entry.byteLength))
    ) {
      throw new Error('orcad_migration_snapshot_transfer_incomplete')
    }
  }
  const commit = async () => {
    assertCurrent()
    const result = await remote.commit(options.pairingCode, cutover.manifest, requestOptions)
    assertCurrent()
    return parseOrcadMigrationCatalogState(result, cutover.manifest)
  }
  state = await resolveDurableOrcadCatalogMutation(
    commit,
    read,
    (observed) => observed.state === 'committed'
  )
  if (state.state !== 'committed') {
    throw new Error(`orcad_migration_commit_not_committed:${state.state}`)
  }
  cutover = await recordOrcadLiveCutoverProgressDurably({
    ...options,
    migrationId: cutover.manifest.migrationId,
    next: { ...cutover, phase: 'destination-committed', receipt: state.receipt }
  })
  assertCurrent()
  return cutover
}
