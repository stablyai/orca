import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { fenceOutgoingPtyRegistrations } from '../runtime/outgoing-pty-registration-fence'
import { withOrcadCommittedSuccessorProfileAuthority } from './orcad-committed-profile-authority'
import { OrcadLiveSourceRetirementRecordStore } from './orcad-live-source-retirement-record'
import { bindOrcadLiveCancellationCohort } from './orcad-live-cancellation-cohort'
import { bindOrcadLiveAppliedCoverageEvidence } from './orcad-live-applied-coverage-evidence'
import { bindOrcadLiveSuccessorControlAbsence } from './orcad-live-successor-control-absence'
import { reconfirmOrcadLiveCleanupDestination } from './orcad-live-cleanup-destination-authority'
import { inspectOrcadLiveCatalogActivationCohort } from './orcad-live-destination-activation'
import {
  assertOrcadLiveSourceReleaseCompatible,
  parseOrcadLiveSourceReleaseIntent
} from './orcad-live-source-release-intent'

type SuccessorReadinessOptions = {
  profileDirectory: string
  migrationId: string
  signal: AbortSignal
  allowCompleted?: boolean
  store: Pick<
    Store,
    'getSshTarget' | 'listOrcadMigrationSourceCutovers' | 'inspectOrcadLiveRetirementProfileState'
  >
  runtime: Pick<OrcaRuntimeService, 'bindOutgoingSshPtySurfaceAbsence'>
  remote?: Parameters<typeof reconfirmOrcadLiveCleanupDestination>[0]['remote']
  activate?: Parameters<typeof inspectOrcadLiveCatalogActivationCohort>[0]['activate']
}

/** Current successor readiness only; neither route retirement nor durable completion is inferred. */
export function withOrcadLiveSuccessorReadiness<T>(
  options: SuccessorReadinessOptions,
  operation: (context: {
    record: NonNullable<ReturnType<OrcadLiveSourceRetirementRecordStore['read']>>
    appliedEvidence: ReturnType<typeof bindOrcadLiveAppliedCoverageEvidence>['evidence']
    receipts: ReturnType<typeof bindOrcadLiveCancellationCohort>['receipts']
    assertCurrent: () => void
    transitionCompletedJournal: (candidate: unknown, write: () => void) => void
  }) => Promise<T>
): Promise<T> {
  return withOrcadCommittedSuccessorProfileAuthority(options, async (authority) => {
    const records = new OrcadLiveSourceRetirementRecordStore(options.profileDirectory)
    const record = records.read(authority.cutover.liveTerminalBindings![0].identity)
    if (
      !record ||
      serializeOrcadMigrationValue(record.release.cutover) !==
        serializeOrcadMigrationValue(authority.cutover)
    ) {
      throw new Error('orcad_live_successor_readiness_record_required')
    }
    const canonicalRecord = serializeOrcadMigrationValue(record)
    const cancellation = bindOrcadLiveCancellationCohort(options.profileDirectory, record)
    const applied = bindOrcadLiveAppliedCoverageEvidence(options.profileDirectory, record)
    let active = true
    const assertEvidence = () => {
      if (!active) {
        throw new Error('orcad_live_successor_readiness_released')
      }
      options.signal.throwIfAborted()
      authority.assertAuthority()
      if (
        serializeOrcadMigrationValue(records.read(record.identity)) !== canonicalRecord ||
        options.store.inspectOrcadLiveRetirementProfileState(record).state !== 'profile-installed'
      ) {
        throw new Error('orcad_live_successor_readiness_profile_changed')
      }
      cancellation.assertCancellation(record)
      applied.assertCurrent()
    }
    try {
      assertEvidence()
      const targetId = record.release.cutover.manifest.source.sshTargetId
      const controls = bindOrcadLiveSuccessorControlAbsence({
        targetId,
        signal: options.signal,
        assertAuthority: assertEvidence
      })
      const surfaces = record.release.cutover.liveTerminalBindings!.map(
        ({ identity, surfaceBinding }) => ({
          ptyId: toAppSshPtyId(targetId, identity.terminalId),
          surfaceBinding
        })
      )
      fenceOutgoingPtyRegistrations(
        options.runtime,
        surfaces.map(({ ptyId }) => ptyId)
      )
      const runtime = options.runtime.bindOutgoingSshPtySurfaceAbsence(targetId, surfaces)
      const assertCurrent = () => {
        assertEvidence()
        controls.assertAbsent()
        runtime.assertAbsent()
        controls.assertAbsent()
        assertEvidence()
      }
      assertCurrent()
      await reconfirmOrcadLiveCleanupDestination({
        ...options,
        ...authority,
        cutover: record.release.cutover,
        destinationRuntimeId: record.identity.destinationRuntimeId,
        assertCurrent
      })
      assertCurrent()
      const activated = await inspectOrcadLiveCatalogActivationCohort({
        ...options,
        ...authority,
        cutover: record.release.cutover,
        assertCurrent
      })
      assertCurrent()
      assertOrcadLiveSourceReleaseCompatible(
        parseOrcadLiveSourceReleaseIntent({ version: 1, ...activated }),
        record.release
      )
      const result = await operation({
        record: structuredClone(record),
        appliedEvidence: structuredClone(applied.evidence),
        receipts: structuredClone(cancellation.receipts),
        assertCurrent,
        transitionCompletedJournal: (candidate, write) => {
          assertCurrent()
          authority.transitionCompletedJournal(candidate, write)
          assertCurrent()
        }
      })
      assertCurrent()
      return result
    } finally {
      active = false
    }
  })
}
