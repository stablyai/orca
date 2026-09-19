import type { PersistedState } from '../../../shared/persisted-state-types'
import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'
import { parseOrcadLiveRetirementMarkers } from '../../../shared/orcad-live-retirement-marker'
import { parseOrcadLiveSourceRetirementRecord } from '../../ssh/orcad-live-source-retirement-record'
import {
  inspectOrcadLiveRetirementProfileChanges,
  listOrcadLiveRetirementProfileDrift
} from './orcad-live-retirement-profile-changes'
import { assertOrcadLiveCompletedCutover } from '../../ssh/orcad-live-completed-cutover'
import { hasOrcadLiveRetiredSessionAfterState } from './orcad-live-retired-session-proof'
import {
  requireSourceFence,
  assertSourceTargetIdentity,
  findCutover
} from './orcad-source-cutover-validation'

/** Shared identity evidence; this alone never authorizes destructive profile changes. */
export function inspectOrcadLiveRetirementProfileEvidence(state: PersistedState, value: unknown) {
  const record = parseOrcadLiveSourceRetirementRecord(value)
  const { cutover } = record.release
  const markers = parseOrcadLiveRetirementMarkers(state.orcadLiveRetirementMarkers)
  assertSourceTargetIdentity(requireSourceFence(state, cutover), cutover.manifest)
  const journal = findCutover(state, cutover.manifest.migrationId)
  let completedCutover: ReturnType<typeof assertOrcadLiveCompletedCutover> | undefined
  if (journal?.version === 2 && journal.phase === 'source-retired') {
    try {
      completedCutover = assertOrcadLiveCompletedCutover({
        committed: cutover,
        completed: journal,
        completionEvidence: { ...journal.sourceCompletion, retirementRecordSha256: record.sha256 }
      })
    } catch {
      return { state: 'conflict' as const, record, diagnostic: { reason: 'completed-journal' } }
    }
  }
  if (
    !completedCutover &&
    serializeOrcadMigrationValue(journal) !== serializeOrcadMigrationValue(cutover)
  ) {
    return { state: 'conflict' as const, record, diagnostic: { reason: 'journal' } }
  }
  const marker = markers.find((entry) => entry.migrationId === cutover.manifest.migrationId)
  return { state: 'evidence' as const, record, marker, completedCutover }
}

/** Local profile state only; an installed marker says nothing about runtime route release. */
export function inspectOrcadLiveRetirementProfileState(state: PersistedState, value: unknown) {
  const evidence = inspectOrcadLiveRetirementProfileEvidence(state, value)
  if (evidence.state === 'conflict') {
    return { state: evidence.state, record: evidence.record, diagnostic: evidence.diagnostic }
  }
  const { record, marker, completedCutover } = evidence
  const slices = inspectOrcadLiveRetirementProfileChanges(state, record.changes)
  if (!completedCutover && !marker && slices === 'before') {
    return { state: 'prepared' as const, record }
  }
  if (
    marker?.recordSha256 === record.sha256 &&
    hasOrcadLiveRetiredSessionAfterState(state, record)
  ) {
    return {
      state: 'profile-installed' as const,
      record,
      marker,
      ...(completedCutover ? { completedCutover } : {})
    }
  }
  return {
    state: 'conflict' as const,
    record,
    diagnostic: {
      reason: 'marker-or-fields',
      markerMatches: marker?.recordSha256 === record.sha256,
      fields: listOrcadLiveRetirementProfileDrift(state, record.changes)
    }
  }
}
