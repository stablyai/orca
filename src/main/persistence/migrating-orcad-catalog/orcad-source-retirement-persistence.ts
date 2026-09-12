import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'
import { parseOrcadLiveRetirementMarkers } from '../../../shared/orcad-live-retirement-marker'
import { createOrcadLiveSourceRetirementRecord } from '../../ssh/orcad-live-source-retirement-record'
import { buildOrcadLiveSourceRetirementCandidate } from './orcad-live-source-retirement-candidate'
import { collectOrcadLiveRetirementProfileChanges } from './orcad-live-retirement-profile-changes'
import {
  inspectOrcadLiveRetirementProfileState,
  inspectOrcadLiveRetirementProfileEvidence
} from './orcad-live-retirement-profile-state'
import { assertOrcadLiveSuccessorProfileChanges } from './orcad-live-successor-profile-changes'
import type { SshPtyConsumerRecovery } from '../../../shared/ssh-types'
import type { OrcadSourceCutoverRuntime } from './orcad-source-cutover-context'
import { scheduleSave, type WriteSchedulingOperations } from '../loading-store/write-scheduling'
import { assertOrcadLiveCompletedCutover } from '../../ssh/orcad-live-completed-cutover'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'

const retirementContext = Symbol('OrcadSourceRetirementPersistence')
type Admission = Parameters<typeof createOrcadLiveSourceRetirementRecord>[0]['sourceAdmission']
type RetirementRuntime = OrcadSourceCutoverRuntime &
  Pick<StoreRuntimeState, 'orcadRetirementSessionPublication'>

export class OrcadSourceRetirementPersistence {
  readonly [retirementContext]: {
    runtime: RetirementRuntime
    scheduling: WriteSchedulingOperations
    sourceCatalog?: Parameters<typeof buildOrcadLiveSourceRetirementCandidate>[0]['sourceCatalog']
  }

  constructor(
    runtime: RetirementRuntime,
    scheduling: WriteSchedulingOperations,
    sourceCatalog?: Parameters<typeof buildOrcadLiveSourceRetirementCandidate>[0]['sourceCatalog']
  ) {
    this[retirementContext] = { runtime, scheduling, sourceCatalog }
  }

  createOrcadLiveSourceRetirementRecord(release: unknown, sourceAdmission: Admission) {
    const runtime = this[retirementContext].runtime
    return createOrcadLiveSourceRetirementRecord({
      release,
      sourceAdmission,
      state: runtime.state,
      storage: runtime.terminalScrollbackSnapshotStorage,
      sourceCatalog: this[retirementContext].sourceCatalog
    })
  }

  listOrcadLiveRetirementMarkers() {
    return parseOrcadLiveRetirementMarkers(
      this[retirementContext].runtime.state.orcadLiveRetirementMarkers
    )
  }

  inspectOrcadLiveRetirementProfileState(record: unknown) {
    return inspectOrcadLiveRetirementProfileState(this[retirementContext].runtime.state, record)
  }

  /** Admission holds validated durable evidence and fresh authority; acknowledgment requires profile flush. */
  completeOrcadLiveRetirementProfile(
    value: unknown,
    candidate: unknown,
    admission: { completionEvidence: unknown; assertCurrent: () => void }
  ) {
    const { runtime, scheduling } = this[retirementContext]
    const inspect = () => {
      const inspection = inspectOrcadLiveRetirementProfileState(runtime.state, value)
      if (inspection.state !== 'profile-installed') {
        throw new Error('orcad_live_completion_profile_not_installed')
      }
      const completed = assertOrcadLiveCompletedCutover({
        committed: inspection.record.release.cutover,
        completed: candidate,
        completionEvidence: admission.completionEvidence
      })
      if (
        completed.sourceCompletion.retirementRecordSha256 !== inspection.record.sha256 ||
        (inspection.completedCutover &&
          serializeOrcadMigrationValue(inspection.completedCutover) !==
            serializeOrcadMigrationValue(completed))
      ) {
        throw new Error('orcad_live_completion_profile_candidate_changed')
      }
      return completed
    }
    const expected = serializeOrcadMigrationValue(inspect())
    admission.assertCurrent()
    const completed = inspect()
    if (serializeOrcadMigrationValue(completed) !== expected) {
      throw new Error('orcad_live_completion_profile_candidate_changed')
    }
    const journals = runtime.state.orcadMigrationSourceCutovers ?? []
    const matches = journals.filter(
      (entry) => entry.manifest.migrationId === completed.manifest.migrationId
    )
    if (matches.length !== 1) {
      throw new Error('orcad_live_completion_profile_journal_conflict')
    }
    runtime.state.orcadMigrationSourceCutovers = journals.map((entry) =>
      entry === matches[0] ? structuredClone(completed) : entry
    )
    scheduleSave(scheduling)
    return structuredClone(completed)
  }

  /** Caller retains durable preparation and fresh activation authority; acknowledgment requires flush. */
  installOrcadLiveRetirementProfile(
    value: unknown,
    sourceAdmission: Admission,
    installedAt: string
  ) {
    const { runtime, scheduling } = this[retirementContext]
    const inspection = inspectOrcadLiveRetirementProfileState(runtime.state, value)
    if (inspection.state !== 'prepared') {
      throw new Error('orcad_live_retirement_profile_not_prepared')
    }
    const { record } = inspection
    const candidate = buildOrcadLiveSourceRetirementCandidate({
      state: runtime.state,
      cutover: record.release.cutover,
      sourceAdmission,
      storage: runtime.terminalScrollbackSnapshotStorage,
      sourceCatalog: this[retirementContext].sourceCatalog
    })
    if (
      serializeOrcadMigrationValue(
        collectOrcadLiveRetirementProfileChanges(runtime.state, candidate)
      ) !== serializeOrcadMigrationValue(record.changes)
    ) {
      throw new Error('orcad_live_retirement_profile_candidate_changed')
    }
    sourceAdmission.assertCurrent()
    if (inspectOrcadLiveRetirementProfileState(runtime.state, record).state !== 'prepared') {
      throw new Error('orcad_live_retirement_profile_not_prepared')
    }
    return installRetirementCandidate(runtime, scheduling, record, candidate, installedAt)
  }

  /** Separate successor admission must retain native exclusion and complete cancellation evidence. */
  installOrcadLiveSuccessorRetirementProfile(
    value: unknown,
    sourceAdmission: Admission & {
      owner: SshPtyConsumerRecovery
      assertCancellation: (record: unknown) => void
    },
    installedAt: string
  ) {
    const { runtime, scheduling, sourceCatalog } = this[retirementContext]
    const evidence = inspectOrcadLiveRetirementProfileEvidence(runtime.state, value)
    if (evidence.state !== 'evidence' || evidence.marker || evidence.completedCutover) {
      throw new Error('orcad_live_successor_profile_not_prepared')
    }
    const { record } = evidence
    const before = serializeOrcadMigrationValue(runtime.state)
    sourceAdmission.assertCancellation(record)
    const candidate = buildOrcadLiveSourceRetirementCandidate({
      state: runtime.state,
      cutover: record.release.cutover,
      sourceAdmission,
      storage: runtime.terminalScrollbackSnapshotStorage,
      sourceCatalog
    })
    assertOrcadLiveSuccessorProfileChanges({
      state: runtime.state,
      candidate,
      record,
      owner: sourceAdmission.owner
    })
    const verifiedCandidate = serializeOrcadMigrationValue(candidate)
    sourceAdmission.assertCurrent()
    sourceAdmission.assertCancellation(record)
    if (
      serializeOrcadMigrationValue(runtime.state) !== before ||
      serializeOrcadMigrationValue(candidate) !== verifiedCandidate
    ) {
      throw new Error('orcad_live_successor_profile_state_changed')
    }
    return installRetirementCandidate(runtime, scheduling, record, candidate, installedAt)
  }
}

function installRetirementCandidate(
  runtime: RetirementRuntime,
  scheduling: WriteSchedulingOperations,
  record: ReturnType<typeof createOrcadLiveSourceRetirementRecord>,
  candidate: RetirementRuntime['state'],
  installedAt: string
) {
  const markers = parseOrcadLiveRetirementMarkers([
    ...parseOrcadLiveRetirementMarkers(runtime.state.orcadLiveRetirementMarkers),
    {
      version: 1,
      migrationId: record.release.cutover.manifest.migrationId,
      recordSha256: record.sha256,
      installedAt
    }
  ])
  runtime.orcadRetirementSessionPublication.record(record)
  // Install freshly validated typed state, never decoded opaque rollback JSON.
  for (const { field } of record.changes) {
    if (candidate[field] === undefined) {
      delete runtime.state[field]
    } else {
      Object.assign(runtime.state, { [field]: candidate[field] })
    }
  }
  runtime.state.orcadLiveRetirementMarkers = markers
  scheduleSave(scheduling)
  return structuredClone(
    markers.find((entry) => entry.migrationId === record.release.cutover.manifest.migrationId)!
  )
}

export function installOrcadSourceRetirementPersistenceContext(
  target: object,
  source: OrcadSourceRetirementPersistence
) {
  Object.defineProperty(target, retirementContext, { value: source[retirementContext] })
}
