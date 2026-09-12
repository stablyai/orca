import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { fenceOutgoingPtyRegistrations } from '../runtime/outgoing-pty-registration-fence'
import { withOrcadCommittedSuccessorProfileAuthority } from './orcad-committed-profile-authority'
import { OrcadLiveSourceRetirementRecordStore } from './orcad-live-source-retirement-record'
import { bindOrcadLiveCancellationCohort } from './orcad-live-cancellation-cohort'
import { groupOrcadLiveCatalogAdmissions } from './orcad-live-catalog-admissions'
import { bindOrcadLiveRetirementCapture } from './orcad-live-retirement-capture'
import { retainOrcadLiveSuccessorSession } from './orcad-live-successor-session'
import { bindOrcadLiveSuccessorProfileAdmission } from './orcad-live-successor-profile-admission'
import { cleanupOrcadLiveSuccessorRuntime } from './orcad-live-successor-runtime-cleanup'
import { reconfirmOrcadLiveCleanupDestination } from './orcad-live-cleanup-destination-authority'
import { inspectOrcadLiveCatalogActivationCohort } from './orcad-live-destination-activation'
import { inspectRemoteOrcadCatalogOutputCoverage } from './orcad-catalog-output-coverage-client'
import { parseOrcadCatalogOutputCoverageResult } from './orcad-catalog-output-coverage-contract'
import {
  createOrcadLiveAppliedCoverageEvidence,
  bindOrcadLiveAppliedCoverageEvidence,
  OrcadLiveAppliedCoverageEvidenceStore
} from './orcad-live-applied-coverage-evidence'
import {
  assertOrcadLiveSourceReleaseCompatible,
  parseOrcadLiveSourceReleaseIntent
} from './orcad-live-source-release-intent'

/** Installs the source profile only; runtime cleanup history and migration completion remain separate. */
export async function installOrcadLiveSuccessorSourceProfile(options: {
  profileDirectory: string
  store: Pick<
    Store,
    | 'getSshTarget'
    | 'listOrcadMigrationSourceCutovers'
    | 'getSshPtyConsumerRecovery'
    | 'upsertSshPtyConsumerRecovery'
    | 'getSshRemotePtyLeases'
    | 'inspectOrcadLiveRetirementProfileState'
    | 'installOrcadLiveSuccessorRetirementProfile'
    | 'flushPendingOrThrowAsync'
  >
  runtime: Pick<OrcaRuntimeService, 'bindOutgoingSshPtySurfaceAbsence'> &
    Partial<Pick<OrcaRuntimeService, 'prepareOutgoingSshPtyGraphAndModelCleanup'>>
  migrationId: string
  signal: AbortSignal
  now?: () => Date
  remote?: Parameters<typeof reconfirmOrcadLiveCleanupDestination>[0]['remote']
  activate?: Parameters<typeof inspectOrcadLiveCatalogActivationCohort>[0]['activate']
  inspectCoverage?: typeof inspectRemoteOrcadCatalogOutputCoverage
}) {
  return withOrcadCommittedSuccessorProfileAuthority(options, async (authority) => {
    const records = new OrcadLiveSourceRetirementRecordStore(options.profileDirectory)
    const record = records.read(authority.intent.liveTerminalBindings![0].identity)
    if (
      !record ||
      serializeOrcadMigrationValue(record.release.cutover) !==
        serializeOrcadMigrationValue(authority.cutover)
    ) {
      throw new Error('orcad_live_successor_retirement_record_required')
    }
    const cancellation = bindOrcadLiveCancellationCohort(options.profileDirectory, record)
    const assertEvidence = () => {
      options.signal.throwIfAborted()
      authority.assertAuthority()
      cancellation.assertCancellation(record)
    }
    assertEvidence()
    const targetId = authority.cutover.manifest.source.sshTargetId
    const surfaces = record.release.cutover.liveTerminalBindings!.map(({ surfaceBinding }) => ({
      ptyId: toAppSshPtyId(targetId, surfaceBinding.ptyId),
      surfaceBinding
    }))
    fenceOutgoingPtyRegistrations(
      options.runtime,
      surfaces.map(({ ptyId }) => ptyId)
    )
    let absence: ReturnType<OrcaRuntimeService['bindOutgoingSshPtySurfaceAbsence']> | undefined
    const assertInstalledAuthority = () => {
      assertEvidence()
      absence?.assertAbsent()
    }
    assertInstalledAuthority()
    await reconfirmOrcadLiveCleanupDestination({
      ...options,
      ...authority,
      cutover: record.release.cutover,
      destinationRuntimeId: record.identity.destinationRuntimeId,
      assertCurrent: assertInstalledAuthority
    })
    const activated = await inspectOrcadLiveCatalogActivationCohort({
      ...options,
      ...authority,
      cutover: record.release.cutover,
      assertCurrent: assertInstalledAuthority
    })
    assertInstalledAuthority()
    assertOrcadLiveSourceReleaseCompatible(
      parseOrcadLiveSourceReleaseIntent({ version: 1, ...activated }),
      record.release
    )
    const appliedCoverages: ReturnType<typeof parseOrcadCatalogOutputCoverageResult>[] = []
    for (const receipt of cancellation.receipts) {
      if (receipt.version !== 2) {
        continue
      }
      const admission = groupOrcadLiveCatalogAdmissions(authority.cutover).find((entry) =>
        entry.bindings.some(({ identity }) => identity.bridgeId === receipt.identity.bridgeId)
      )!
      const publication = activated.activations.find(
        (entry) => entry.identity.bridgeId === receipt.identity.bridgeId
      )!
      const request = {
        identity: receipt.identity,
        publicationReceipt: publication.publicationReceipt,
        catalogAdmission: admission,
        throughSeq: receipt.retirement.coveredSourceDeliveryRetirement.sourceOutputEndSeq
      }
      assertInstalledAuthority()
      const observed = parseOrcadCatalogOutputCoverageResult(
        await (options.inspectCoverage ?? inspectRemoteOrcadCatalogOutputCoverage)({
          pairingCode: authority.pairingCode,
          request,
          signal: options.signal
        }),
        request
      )
      assertInstalledAuthority()
      assertOrcadLiveSourceReleaseCompatible(
        parseOrcadLiveSourceReleaseIntent({
          version: 1,
          cutover: activated.cutover,
          activations: activated.activations.map((entry) =>
            entry.identity.bridgeId === observed.identity.bridgeId ? observed : entry
          )
        }),
        parseOrcadLiveSourceReleaseIntent({ version: 1, ...activated })
      )
      appliedCoverages.push(observed)
    }
    const applied = createOrcadLiveAppliedCoverageEvidence({
      ...options,
      record,
      coverages: appliedCoverages
    })
    const appliedStore = new OrcadLiveAppliedCoverageEvidenceStore(options.profileDirectory)
    const previous = appliedStore.read(record.identity)
    if (previous) {
      const retained = bindOrcadLiveAppliedCoverageEvidence(options.profileDirectory, record)
      for (const old of retained.evidence.coverages) {
        const fresh = applied.coverages.find(
          (entry) => entry.identity.bridgeId === old.identity.bridgeId
        )!
        if (
          fresh.destinationClaim.generation < old.destinationClaim.generation ||
          (fresh.destinationClaim.generation === old.destinationClaim.generation &&
            fresh.destinationClaim.claimId !== old.destinationClaim.claimId) ||
          fresh.coverage.acknowledgedEndSeq < old.coverage.acknowledgedEndSeq ||
          fresh.coverage.modelThroughSeq < old.coverage.modelThroughSeq ||
          fresh.coverage.modelSequenceEnd < old.coverage.modelSequenceEnd
        ) {
          throw new Error('orcad_live_applied_coverage_regressed')
        }
      }
      retained.assertCurrent()
      appliedStore.persist(retained.evidence)
    } else {
      appliedStore.persist(applied)
    }
    const appliedEvidence = bindOrcadLiveAppliedCoverageEvidence(options.profileDirectory, record)
    const assertApplied = () => {
      assertInstalledAuthority()
      appliedEvidence.assertCurrent()
    }
    assertApplied()
    absence = await cleanupOrcadLiveSuccessorRuntime({
      ...options,
      record,
      assertAuthority: assertApplied
    })
    assertApplied()
    const initial = options.store.inspectOrcadLiveRetirementProfileState(record)
    // Successor before-state drift is checked by the typed installer, not the ordinary inspector.
    if (initial.state !== 'profile-installed') {
      const captures = groupOrcadLiveCatalogAdmissions(authority.cutover).flatMap(
        (catalogAdmission) =>
          catalogAdmission.bindings.map(({ identity }) =>
            bindOrcadLiveRetirementCapture({
              ...options,
              identity,
              catalogAdmission,
              destinationEnvironmentId: authority.cutover.destinationEnvironmentId,
              assertAuthority: assertInstalledAuthority
            })
          )
      )
      const assertPrepared = () => {
        assertApplied()
        for (const capture of captures) {
          capture.assertCurrent()
        }
      }
      assertPrepared()
      const retained = await retainOrcadLiveSuccessorSession({
        ...options,
        targetId,
        captures: captures.map(({ capture }) => capture),
        assertAuthority: assertPrepared
      })
      let failure: { error: unknown } | undefined
      try {
        const sourceAdmission = bindOrcadLiveSuccessorProfileAdmission({
          record,
          store: options.store,
          retained,
          signal: options.signal,
          assertAuthority: assertPrepared,
          assertRuntimeAbsent: absence.assertAbsent,
          assertCancellation: cancellation.assertCancellation
        })
        options.store.installOrcadLiveSuccessorRetirementProfile(
          record,
          sourceAdmission,
          (options.now ?? (() => new Date()))().toISOString()
        )
        // Installation removes saved owner evidence; only independent authority survives it.
        assertApplied()
      } catch (error) {
        failure = { error }
      }
      try {
        await retained.dispose()
      } catch (cleanupError) {
        if (failure) {
          throw new AggregateError(
            [failure.error, cleanupError],
            'orcad_live_successor_profile_cleanup_failed'
          )
        }
        throw cleanupError
      }
      if (failure) {
        throw failure.error
      }
    }
    assertApplied()
    await options.store.flushPendingOrThrowAsync({
      signal: options.signal,
      drainToStableGeneration: false
    })
    assertApplied()
    const saved = options.store.inspectOrcadLiveRetirementProfileState(record)
    if (saved.state !== 'profile-installed') {
      throw new Error('orcad_live_successor_profile_installation_unconfirmed')
    }
    return { record, marker: saved.marker }
  })
}
