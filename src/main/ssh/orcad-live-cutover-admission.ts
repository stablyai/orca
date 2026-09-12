import type { Store } from '../persistence'
import type { bindOutgoingOrcadCatalogSource } from './orcad-outgoing-catalog-source'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import {
  OrcadLiveCutoverIntentStore,
  parseOrcadLiveCutoverIntent
} from './orcad-live-cutover-intent-store'
import { inspectOrcadLiveCutoverRecovery } from './orcad-live-cutover-recovery-inspection'

/** Caller holds lifecycle locks across the explicit unowned-to-fenced authority transition. */
export async function beginOrcadLiveSourceCutoverDurably(options: {
  profileDirectory: string
  store: Pick<
    Store,
    | 'getSshTarget'
    | 'listOrcadMigrationSourceCutovers'
    | 'beginOrcadLiveSourceCutover'
    | 'flushPendingOrThrowAsync'
  >
  intent: unknown
  sourceAdmission: Pick<
    ReturnType<typeof bindOutgoingOrcadCatalogSource>,
    'assertBindings' | 'projectSourceState' | 'fenceCreation'
  >
  signal: AbortSignal
  assertAuthority: (expectedOwner: 'unowned' | 'fenced') => void
}) {
  options.signal.throwIfAborted()
  const intent = parseOrcadLiveCutoverIntent(options.intent)
  options.sourceAdmission.assertBindings(intent.liveTerminalBindings)
  const existing = inspectOrcadLiveCutoverRecovery(options.profileDirectory, options.store).find(
    (entry) => entry.intent.manifest.source.sshTargetId === intent.manifest.source.sshTargetId
  )
  if (
    existing?.state === 'phase-unverifiable' ||
    (existing?.journal && existing.journal.phase !== 'source-fenced')
  ) {
    throw new Error('orcad_live_cutover_phase_observation_required')
  }
  const owner = existing?.journal ? 'fenced' : 'unowned'
  options.assertAuthority(owner)
  await options.sourceAdmission.fenceCreation()
  const retained = new OrcadLiveCutoverIntentStore(options.profileDirectory).persist(intent)
  options.signal.throwIfAborted()
  options.assertAuthority(owner)
  options.sourceAdmission.assertBindings(retained.liveTerminalBindings)
  const admitted = options.store.beginOrcadLiveSourceCutover(
    retained,
    options.sourceAdmission.projectSourceState
  )
  options.assertAuthority('fenced')
  await options.store.flushPendingOrThrowAsync({
    signal: options.signal,
    drainToStableGeneration: false
  })
  options.signal.throwIfAborted()
  options.assertAuthority('fenced')
  const saved = inspectOrcadLiveCutoverRecovery(options.profileDirectory, options.store).find(
    (entry) => entry.intent.manifest.migrationId === intent.manifest.migrationId
  )?.journal
  if (serializeOrcadMigrationValue(saved) !== serializeOrcadMigrationValue(admitted)) {
    throw new Error('orcad_live_cutover_admission_changed')
  }
  return admitted
}
