import type { PersistedState } from '../../../shared/persisted-state-types'
import { parseOrcadLiveRetirementMarkers } from '../../../shared/orcad-live-retirement-marker'
import {
  OrcadLiveSourceRetirementRecordStore,
  type parseOrcadLiveSourceRetirementRecord
} from '../../ssh/orcad-live-source-retirement-record'
import { hasOrcadRetirementPublicationAuthority } from '../migrating-orcad-catalog/orcad-retirement-publication-proof'

type RetirementRecord = ReturnType<typeof parseOrcadLiveSourceRetirementRecord>

export class OrcadRetirementSessionPublication {
  private readonly records: OrcadLiveSourceRetirementRecordStore
  private readonly cache = new Map<string, RetirementRecord>()

  constructor(profileDirectory: string) {
    this.records = new OrcadLiveSourceRetirementRecordStore(profileDirectory)
  }

  record(value: unknown): void {
    const record = this.records.persist(value)
    this.cache.set(record.sha256, record)
  }

  installedRecords(state: PersistedState): RetirementRecord[] {
    const markers = parseOrcadLiveRetirementMarkers(state.orcadLiveRetirementMarkers)
    if (markers.length === 0) {
      return []
    }
    if (markers.some((marker) => !this.cache.has(marker.recordSha256))) {
      for (const record of this.records.list()) {
        this.cache.set(record.sha256, record)
      }
    }
    return markers.map((marker) => {
      const record = this.cache.get(marker.recordSha256)
      if (
        !record ||
        record.release.cutover.manifest.migrationId !== marker.migrationId ||
        !hasOrcadRetirementPublicationAuthority(state, record)
      ) {
        throw new Error('orcad_retirement_session_publication_evidence_invalid')
      }
      return structuredClone(record)
    })
  }
}
