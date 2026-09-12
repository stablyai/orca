import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { prepareOrcadLiveSourceReleaseUnderAuthority } from './orcad-live-source-release-preparation'
import { assertOrcadLiveSourceReleaseCompatible } from './orcad-live-source-release-intent'
import { OrcadLiveSourceRetirementRecordStore } from './orcad-live-source-retirement-record'
import { assertOrcadLiveCutoverCurrent } from './orcad-live-cutover-current'
import { withOrcadLiveSourceRecovery } from './orcad-live-source-recovery'

/** Retains rollback evidence under source authority; never installs the candidate profile. */
export async function prepareOrcadLiveSourceRetirementUnderAuthority(
  options: Parameters<typeof prepareOrcadLiveSourceReleaseUnderAuthority>[0]
) {
  const prepared = await prepareOrcadLiveSourceReleaseUnderAuthority(options)
  const assertCurrent = () =>
    assertOrcadLiveCutoverCurrent({ ...options, cutover: prepared.intent.cutover })
  assertCurrent()
  const buildRecord = () =>
    options.store.createOrcadLiveSourceRetirementRecord(
      { ...prepared.intent, activations: prepared.activations },
      options.sourceAdmission
    )
  const candidate = buildRecord()
  const store = new OrcadLiveSourceRetirementRecordStore(options.profileDirectory)
  const existing = store.read(candidate.identity)
  if (existing) {
    assertOrcadLiveSourceReleaseCompatible(candidate.release, existing.release)
    if (
      serializeOrcadMigrationValue(candidate.changes) !==
      serializeOrcadMigrationValue(existing.changes)
    ) {
      throw new Error('orcad_live_source_retirement_record_conflict')
    }
  }
  assertCurrent()
  const record = store.persist(existing ?? candidate)
  assertCurrent()
  if (
    serializeOrcadMigrationValue(buildRecord().changes) !==
    serializeOrcadMigrationValue(record.changes)
  ) {
    throw new Error('orcad_live_source_retirement_record_conflict')
  }
  assertCurrent()
  return { record, activations: prepared.activations }
}

export async function prepareOrcadLiveSourceRetirement(
  options: Parameters<typeof withOrcadLiveSourceRecovery>[0] &
    Pick<Parameters<typeof prepareOrcadLiveSourceReleaseUnderAuthority>[0], 'remote' | 'activate'>
) {
  return withOrcadLiveSourceRecovery(options, (context) =>
    prepareOrcadLiveSourceRetirementUnderAuthority({ ...options, ...context })
  )
}
