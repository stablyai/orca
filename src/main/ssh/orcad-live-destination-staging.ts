import type { Store } from '../persistence'
import { parseOrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import { parseOrcadMigrationCatalogState } from '../../shared/orcad-migration-catalog-state'
import { assertOrcadLiveCutoverCurrent } from './orcad-live-cutover-current'
import type { bindOutgoingOrcadCatalogSource } from './orcad-outgoing-catalog-source'
import {
  readRemoteOrcadMigrationCatalogState,
  stageRemoteOrcadMigrationCatalog,
  stageRemoteOrcadMigrationSnapshotChunk
} from './orcad-migration-catalog-client'
import { resolveDurableOrcadCatalogMutation } from './orcad-catalog-durable-mutation'
import { recordOrcadLiveCutoverProgressDurably } from './orcad-live-cutover-progress'
import { transferOrcadMigrationSnapshots } from './orcad-migration-snapshot-coordinator'

export async function stageOrcadLiveDestination(options: {
  profileDirectory: string
  store: Store
  cutover: unknown
  pairingCode: string
  sourceAdmission: ReturnType<typeof bindOutgoingOrcadCatalogSource>
  signal: AbortSignal
  assertAuthority: () => void
  remote?: {
    read: typeof readRemoteOrcadMigrationCatalogState
    stage: typeof stageRemoteOrcadMigrationCatalog
    snapshot: typeof stageRemoteOrcadMigrationSnapshotChunk
  }
}) {
  let cutover = parseOrcadMigrationSourceCutover(options.cutover)
  if (
    cutover.version !== 2 ||
    (cutover.phase !== 'source-fenced' && cutover.phase !== 'destination-staged')
  ) {
    throw new Error('orcad_live_cutover_phase_observation_required')
  }
  const assertCurrent = () => assertOrcadLiveCutoverCurrent({ ...options, cutover })
  const remote = options.remote ?? {
    read: readRemoteOrcadMigrationCatalogState,
    stage: stageRemoteOrcadMigrationCatalog,
    snapshot: stageRemoteOrcadMigrationSnapshotChunk
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
  if (state.state === 'absent') {
    if (cutover.phase !== 'source-fenced' || (cutover.terminalPublications?.length ?? 0) > 0) {
      throw new Error('orcad_live_cutover_destination_state_regressed')
    }
  }
  if (state.state === 'absent' || state.state === 'staged') {
    state = await resolveDurableOrcadCatalogMutation(
      async () => {
        assertCurrent()
        const result = await remote.stage(options.pairingCode, cutover.manifest, requestOptions)
        assertCurrent()
        return parseOrcadMigrationCatalogState(result, cutover.manifest)
      },
      read,
      (observed) => observed.state === 'staged'
    )
  }
  if (state.state !== 'staged') {
    throw new Error('orcad_live_cutover_phase_observation_required')
  }
  const next = { ...cutover, phase: 'destination-staged', stagedAt: state.stagedAt }
  cutover = await recordOrcadLiveCutoverProgressDurably({
    profileDirectory: options.profileDirectory,
    store: options.store,
    migrationId: cutover.manifest.migrationId,
    next,
    signal: options.signal,
    assertAuthority: options.assertAuthority
  })
  await transferOrcadMigrationSnapshots({
    store: {
      readOrcadMigrationSourceSnapshotChunk: (...args) => {
        assertCurrent()
        return options.store.readOrcadMigrationSourceSnapshotChunk(...args)
      }
    },
    cutover,
    pairingCode: options.pairingCode,
    state,
    requestOptions,
    remote: {
      read: async () => read(),
      snapshot: async (...args) => {
        assertCurrent()
        const result = await remote.snapshot(...args)
        assertCurrent()
        return result
      }
    }
  })
  assertCurrent()
  return cutover
}
