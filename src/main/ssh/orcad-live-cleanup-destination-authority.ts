import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { parseOrcadMigrationCatalogState } from '../../shared/orcad-migration-catalog-state'
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import {
  readRemoteOrcadMigrationCatalogState,
  commitRemoteOrcadMigrationCatalog
} from './orcad-migration-catalog-client'
import { resolveDurableOrcadCatalogMutation } from './orcad-catalog-durable-mutation'

export async function reconfirmOrcadLiveCleanupDestination(options: {
  cutover: Extract<OrcadMigrationSourceCutover, { phase: 'destination-committed' }>
  destinationRuntimeId: string
  pairingCode: string
  signal: AbortSignal
  assertCurrent: () => void
  remote?: {
    read: typeof readRemoteOrcadMigrationCatalogState
    commit: typeof commitRemoteOrcadMigrationCatalog
  }
}) {
  const remote = options.remote ?? {
    read: readRemoteOrcadMigrationCatalogState,
    commit: commitRemoteOrcadMigrationCatalog
  }
  const observe = async (operation: typeof remote.read) => {
    options.signal.throwIfAborted()
    options.assertCurrent()
    const state = parseOrcadMigrationCatalogState(
      await operation(options.pairingCode, options.cutover.manifest, {
        signal: options.signal,
        expectedRuntimeId: options.destinationRuntimeId
      }),
      options.cutover.manifest
    )
    options.signal.throwIfAborted()
    options.assertCurrent()
    if (
      state.state !== 'committed' ||
      serializeOrcadMigrationValue(state.receipt) !==
        serializeOrcadMigrationValue(options.cutover.receipt)
    ) {
      throw new Error('orcad_live_control_release_destination_changed')
    }
    return state
  }
  await observe(remote.read)
  await resolveDurableOrcadCatalogMutation(
    () => observe(remote.commit),
    () => observe(remote.read),
    (state) => state.state === 'committed'
  )
}
