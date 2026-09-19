import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { getSshPtyProvider } from '../ipc/pty/provider/registry'
import {
  prepareOutgoingSshPtyRouteRetirement,
  restoreRetiredOutgoingSshPtyRoutes
} from '../ipc/pty/provider/outgoing-source-route-retirement'
import {
  createOrcadLiveSourceRouteCheckpoint,
  OrcadLiveSourceRouteCheckpointStore
} from './orcad-live-source-route-checkpoint'
import { withOrcadLiveRuntimeRestartReadiness } from './orcad-live-runtime-restart-readiness'
import { createOrcadLiveSourceCompletionEvidence } from './orcad-live-source-completion-evidence'
import {
  listValidatedOrcadLiveSourceCompletionPreparations,
  OrcadLiveSourceCompletionPreparationStore
} from './orcad-live-source-completion-preparation'

/** Initial exact registry-route retirement; no provider disposal or whole-migration completion. */
export function retireOrcadLiveSourceRoutes(
  options: Parameters<typeof withOrcadLiveRuntimeRestartReadiness>[0] & { recoveryOnly?: boolean }
) {
  return withOrcadLiveRuntimeRestartReadiness(
    options,
    async ({ record, outputEvidence, assertCurrent }) => {
      const readPreparation = () => {
        const matches = listValidatedOrcadLiveSourceCompletionPreparations(
          options.profileDirectory
        ).filter((entry) => entry.record.sha256 === record.sha256)
        if (matches.length !== 1) {
          throw new Error('orcad_live_source_route_completion_preparation_required')
        }
        return matches[0].preparation
      }
      assertCurrent()
      const preparation = readPreparation()
      const canonical = serializeOrcadMigrationValue(preparation)
      const assertAuthority = () => {
        assertCurrent()
        if (serializeOrcadMigrationValue(readPreparation()) !== canonical) {
          throw new Error('orcad_live_source_route_completion_preparation_changed')
        }
      }
      const targetId = record.release.cutover.manifest.source.sshTargetId
      const binding = {
        targetId,
        identities: preparation.receipts.map(({ identity }) => identity),
        recordSha256: record.sha256,
        assertAuthority
      }
      const checkpoint = createOrcadLiveSourceRouteCheckpoint(preparation)
      const checkpoints = new OrcadLiveSourceRouteCheckpointStore(options.profileDirectory)
      const existing = checkpoints.read(checkpoint.identity)
      if (
        existing &&
        serializeOrcadMigrationValue(existing) !== serializeOrcadMigrationValue(checkpoint)
      ) {
        throw new Error('orcad_live_source_route_checkpoint_conflict')
      }
      const acknowledge = (routes: { assertRetired: () => void }) => {
        routes.assertRetired()
        const saved = checkpoints.persist(checkpoint)
        routes.assertRetired()
        const completionEvidence = createOrcadLiveSourceCompletionEvidence({
          record,
          committed: record.release.cutover,
          preparation,
          settlements: outputEvidence.settlements,
          checkpoint: saved
        })
        routes.assertRetired()
        return {
          phase: 'source-routes-removed' as const,
          sourceRetirement: 'pending' as const,
          checkpoint: saved,
          completionEvidence
        }
      }
      if (options.recoveryOnly) {
        new OrcadLiveSourceCompletionPreparationStore(options.profileDirectory).persist(preparation)
        assertAuthority()
        return acknowledge(restoreRetiredOutgoingSshPtyRoutes(binding))
      }
      const provider = getSshPtyProvider(targetId)
      const generation = (provider as { providerGeneration?: number } | undefined)
        ?.providerGeneration
      if (!provider || generation === undefined) {
        throw new Error('orcad_live_source_route_incumbent_required')
      }
      const routes = prepareOutgoingSshPtyRouteRetirement({
        ...binding,
        expectedProvider: provider,
        providerGeneration: generation
      })
      new OrcadLiveSourceCompletionPreparationStore(options.profileDirectory).persist(preparation)
      routes.assertCurrent()
      routes.retire()
      routes.assertRetired()
      return acknowledge(routes)
    }
  )
}
