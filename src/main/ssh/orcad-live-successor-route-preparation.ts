import { withOrcadLiveSuccessorReadiness } from './orcad-live-successor-readiness'
import {
  assertOutgoingSshPtyRoutesAbsent,
  restoreRetiredOutgoingSshPtyRoutes
} from '../ipc/pty/provider/outgoing-source-route-retirement'
import {
  createOrcadLiveSuccessorCompletionPreparation,
  bindOrcadLiveSuccessorCompletionPreparation,
  OrcadLiveSuccessorCompletionPreparationStore,
  createOrcadLiveSuccessorRouteCheckpoint,
  bindOrcadLiveSuccessorRouteCheckpoint,
  OrcadLiveSuccessorRouteCheckpointStore
} from './orcad-live-successor-completion-records'

/** Restores refusal for absent source routes; does not retire present routes or complete migration. */
export function prepareOrcadLiveSuccessorCompletion(
  options: Parameters<typeof withOrcadLiveSuccessorReadiness>[0]
) {
  return withOrcadLiveSuccessorReadiness(
    options,
    async ({ record, assertCurrent: assertReady }) => {
      const targetId = record.release.cutover.manifest.source.sshTargetId
      const assertCurrent = () => {
        assertReady()
        assertOutgoingSshPtyRoutesAbsent(targetId)
      }
      assertCurrent()
      const candidate = createOrcadLiveSuccessorCompletionPreparation(
        options.profileDirectory,
        record
      )
      assertCurrent()
      new OrcadLiveSuccessorCompletionPreparationStore(options.profileDirectory).persist(candidate)
      assertCurrent()
      const preparation = bindOrcadLiveSuccessorCompletionPreparation(
        options.profileDirectory,
        record
      )
      const assertPrepared = () => {
        assertCurrent()
        preparation.assertCurrent()
      }
      assertPrepared()
      const routes = restoreRetiredOutgoingSshPtyRoutes({
        targetId,
        identities: record.release.cutover.liveTerminalBindings!.map(({ identity }) => identity),
        recordSha256: record.sha256,
        assertAuthority: assertPrepared
      })
      routes.assertRetired()
      const checkpoint = createOrcadLiveSuccessorRouteCheckpoint(preparation.preparation)
      new OrcadLiveSuccessorRouteCheckpointStore(options.profileDirectory).persist(checkpoint)
      routes.assertRetired()
      const bound = bindOrcadLiveSuccessorRouteCheckpoint(options.profileDirectory, record)
      bound.assertCurrent()
      routes.assertRetired()
      return {
        phase: 'successor-source-routes-refused' as const,
        sourceRetirement: 'pending' as const,
        preparation: bound.preparation,
        checkpoint: bound.checkpoint
      }
    }
  )
}
