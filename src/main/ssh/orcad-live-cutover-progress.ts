import type { Store } from '../persistence'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { inspectOrcadLiveCutoverRecovery } from './orcad-live-cutover-recovery-inspection'
import { validateOrcadLiveCutoverTransition } from '../../shared/orcad-live-cutover-transition'

/** Caller holds lifecycle authority and supplies authenticated destination evidence. */
export async function recordOrcadLiveCutoverProgressDurably(options: {
  profileDirectory: string
  store: Pick<
    Store,
    | 'getSshTarget'
    | 'listOrcadMigrationSourceCutovers'
    | 'recordOrcadLiveCutoverProgress'
    | 'flushPendingOrThrowAsync'
  >
  migrationId: string
  next: unknown
  signal: AbortSignal
  assertAuthority: () => void
}) {
  const assertCurrent = () => {
    options.signal.throwIfAborted()
    options.assertAuthority()
  }
  assertCurrent()
  const candidate = inspectOrcadLiveCutoverRecovery(options.profileDirectory, options.store).find(
    (entry) => entry.intent.manifest.migrationId === options.migrationId
  )
  if (!candidate?.journal) {
    throw new Error('orcad_live_cutover_phase_observation_required')
  }
  const next = validateOrcadLiveCutoverTransition(candidate.journal, options.next)
  assertCurrent()
  const recorded = options.store.recordOrcadLiveCutoverProgress(
    options.migrationId,
    candidate.journal,
    next
  )
  await options.store.flushPendingOrThrowAsync({
    signal: options.signal,
    drainToStableGeneration: false
  })
  assertCurrent()
  const saved = inspectOrcadLiveCutoverRecovery(options.profileDirectory, options.store).find(
    (entry) => entry.intent.manifest.migrationId === options.migrationId
  )?.journal
  if (serializeOrcadMigrationValue(saved) !== serializeOrcadMigrationValue(recorded)) {
    throw new Error('orcad_live_cutover_progress_stale')
  }
  return recorded
}
