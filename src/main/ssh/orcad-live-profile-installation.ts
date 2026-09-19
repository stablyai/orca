import type { Store } from '../persistence'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import {
  OrcadLiveSourceRetirementRecordStore,
  parseOrcadLiveSourceRetirementRecord
} from './orcad-live-source-retirement-record'

/** Caller holds lifecycle authority; a prepared profile additionally needs freshly activated source admission. */
export async function installOrcadLiveProfileUnderAuthority(options: {
  store: Pick<
    Store,
    | 'inspectOrcadLiveRetirementProfileState'
    | 'installOrcadLiveRetirementProfile'
    | 'flushPendingOrThrowAsync'
  >
  profileDirectory: string
  record: unknown
  sourceAdmission?: Parameters<Store['installOrcadLiveRetirementProfile']>[1]
  signal: AbortSignal
  assertAuthority: () => void
  now?: () => Date
}) {
  const record = parseOrcadLiveSourceRetirementRecord(options.record)
  const evidence = new OrcadLiveSourceRetirementRecordStore(options.profileDirectory)
  const assertCurrent = () => {
    options.signal.throwIfAborted()
    options.assertAuthority()
    if (
      serializeOrcadMigrationValue(evidence.read(record.identity)) !==
      serializeOrcadMigrationValue(record)
    ) {
      throw new Error('orcad_live_profile_installation_evidence_changed')
    }
  }
  assertCurrent()
  const initial = options.store.inspectOrcadLiveRetirementProfileState(record)
  if (initial.state === 'conflict') {
    throw new Error('orcad_live_profile_installation_conflict')
  }
  evidence.persist(record)
  assertCurrent()
  if (initial.state === 'prepared') {
    if (!options.sourceAdmission) {
      throw new Error('orcad_live_profile_installation_fresh_source_required')
    }
    options.store.installOrcadLiveRetirementProfile(
      record,
      options.sourceAdmission,
      (options.now ?? (() => new Date()))().toISOString()
    )
  }
  await options.store.flushPendingOrThrowAsync({
    signal: options.signal,
    drainToStableGeneration: false
  })
  assertCurrent()
  const saved = options.store.inspectOrcadLiveRetirementProfileState(record)
  if (saved.state !== 'profile-installed') {
    throw new Error('orcad_live_profile_installation_unconfirmed')
  }
  return { record, marker: saved.marker }
}
