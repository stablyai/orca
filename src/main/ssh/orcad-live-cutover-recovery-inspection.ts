import type { Store } from '../persistence'
import { getManagedOrcadOwnerEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import { parseOrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import {
  OrcadLiveCutoverIntentStore,
  parseOrcadLiveCutoverIntent
} from './orcad-live-cutover-intent-store'
import { validateOrcadLiveCompletedRecovery } from './orcad-live-completed-recovery'

/** Local evidence only; missing phase evidence never implies an absent destination catalog. */
export function inspectOrcadLiveCutoverRecovery(
  profileDirectory: string,
  store: Pick<Store, 'getSshTarget' | 'listOrcadMigrationSourceCutovers'>
) {
  const intents = new OrcadLiveCutoverIntentStore(profileDirectory).list()
  const journals = store.listOrcadMigrationSourceCutovers()
  for (const journal of journals) {
    if (
      journal.version === 2 &&
      !intents.some((intent) => intent.manifest.migrationId === journal.manifest.migrationId)
    ) {
      throw new Error('orcad_live_cutover_retained_intent_missing')
    }
  }
  const targets = new Set<string>()
  const migrations = new Set<string>()
  return intents.map((intent) => {
    const { manifest } = intent
    if (targets.has(manifest.source.sshTargetId) || migrations.has(manifest.migrationId)) {
      throw new Error('orcad_live_cutover_intent_conflict')
    }
    targets.add(manifest.source.sshTargetId)
    migrations.add(manifest.migrationId)
    const target = store.getSshTarget(manifest.source.sshTargetId)
    if (
      !target ||
      target.generation !== manifest.source.sshTargetGeneration ||
      target.label !== manifest.source.targetLabel
    ) {
      throw new Error('orcad_live_cutover_source_target_changed')
    }
    const matching = journals.filter(
      (journal) =>
        journal.manifest.migrationId === manifest.migrationId ||
        journal.manifest.source.sshTargetId === target.id
    )
    if (matching.length > 1) {
      throw new Error('orcad_live_cutover_journal_conflict')
    }
    const journal = matching[0] ? parseOrcadMigrationSourceCutover(matching[0]) : undefined
    if (journal) {
      const original =
        journal.version === 2 && journal.phase === 'source-retired'
          ? validateOrcadLiveCompletedRecovery(profileDirectory, journal).record.release.cutover
          : journal
      const initial = parseOrcadLiveCutoverIntent({
        ...original,
        // Participation enrollment is local intent metadata, not a remote journal field.
        ...(intent.profileParticipationRequired ? { profileParticipationRequired: true } : {}),
        terminalPublications: undefined,
        phase: 'source-fenced',
        updatedAt: journal.startedAt
      })
      const expected = { ...intent, updatedAt: intent.startedAt }
      if (serializeOrcadMigrationValue(initial) !== serializeOrcadMigrationValue(expected)) {
        throw new Error('orcad_live_cutover_journal_conflict')
      }
    }
    const owner = getManagedOrcadOwnerEnvironmentId(target.owner)
    if ((target.owner && owner !== intent.destinationEnvironmentId) || (journal && !target.owner)) {
      throw new Error('orcad_live_cutover_source_fence_changed')
    }
    return {
      intent,
      journal,
      state: journal
        ? ('journal-retained' as const)
        : target.owner
          ? ('phase-unverifiable' as const)
          : ('intent-only' as const)
    }
  })
}
