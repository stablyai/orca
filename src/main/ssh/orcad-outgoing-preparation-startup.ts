import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import { OrcadOutgoingPreparationStore } from './orcad-outgoing-preparation-store'
import { OrcadLiveCutoverIntentStore } from './orcad-live-cutover-intent-store'
import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { listValidatedOrcadLiveCleanupPreparations } from './orcad-live-source-cleanup-intent'
import { fenceOutgoingPtyRegistrations } from '../runtime/outgoing-pty-registration-fence'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { listValidatedOrcadLiveRuntimeCleanupCheckpoints } from './orcad-live-runtime-cleanup-checkpoint'
import { listValidatedOrcadLiveCleanupOutputEvidence } from './orcad-live-cleanup-output-evidence'
import { listValidatedOrcadLiveSourceCancellationReceipts } from './orcad-live-source-cancellation-receipt'
import { listValidatedOrcadLiveSourceCompletionPreparations } from './orcad-live-source-completion-preparation'
import { fenceOutgoingSourcePtyRoutes } from '../ipc/pty/provider/outgoing-source-route-refusal'
import { listValidatedOrcadLiveSourceRouteCheckpoints } from './orcad-live-source-route-checkpoint'

/** Restore refusal before provider publication; saved intent never licenses ordinary control replay. */
export async function restoreOutgoingOrcadPreparationAdmission(
  targetId: string,
  mux: Pick<
    SshChannelMultiplexer,
    'fencePtyControlsAndDrain' | 'fencePtyPreparationSurface' | 'fencePtyCatalogCreation'
  >,
  userDataPath = getCanonicalUserDataPath(),
  runtime?: object
): Promise<void> {
  const cutovers = new OrcadLiveCutoverIntentStore(userDataPath)
    .list()
    .filter((intent) => intent.manifest.source.sshTargetId === targetId)
  const preparations = listValidatedOrcadLiveCleanupPreparations(userDataPath)
  const checkpoints = listValidatedOrcadLiveRuntimeCleanupCheckpoints(userDataPath, preparations)
  const outputs = listValidatedOrcadLiveCleanupOutputEvidence(userDataPath, preparations)
  listValidatedOrcadLiveSourceCancellationReceipts(userDataPath, outputs)
  const completions = listValidatedOrcadLiveSourceCompletionPreparations(
    userDataPath,
    outputs,
    checkpoints
  )
  listValidatedOrcadLiveSourceRouteCheckpoints(userDataPath, completions)
  for (const { record, preparation } of completions) {
    if (record.release.cutover.manifest.source.sshTargetId === targetId) {
      fenceOutgoingSourcePtyRoutes(
        targetId,
        preparation.receipts.map(({ identity }) => identity),
        record.sha256
      )
    }
  }
  const cleanups = preparations
    .map(({ record }) => record.release.cutover)
    .filter((cutover) => cutover.manifest.source.sshTargetId === targetId)
  if (runtime) {
    // Saved intent restores refusal, never authority to remove live source state.
    fenceOutgoingPtyRegistrations(
      runtime,
      cleanups.flatMap((cutover) =>
        cutover.liveTerminalBindings!.map(({ identity }) =>
          toAppSshPtyId(targetId, identity.terminalId)
        )
      )
    )
  }
  if (cutovers.length || cleanups.length) {
    mux.fencePtyCatalogCreation()
  }
  const pending = new OrcadOutgoingPreparationStore(userDataPath)
    .list()
    .filter((intent) => intent.sourceSshTargetId === targetId)
  const bindings = [
    ...pending,
    ...[...cutovers, ...cleanups].flatMap((intent) => intent.liveTerminalBindings!)
  ]
  const terminalIds = new Set(bindings.map((intent) => intent.identity.terminalId))
  for (const intent of bindings) {
    mux.fencePtyPreparationSurface(intent.surfaceBinding)
  }
  for (const id of terminalIds) {
    await mux.fencePtyControlsAndDrain(id, new AbortController().signal)
  }
}
