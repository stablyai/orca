import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { withOrcadCommittedProfileAuthority } from './orcad-committed-profile-authority'
import { inspectOrcadLiveRetirementRecovery } from './orcad-live-retirement-recovery-inspection'
import { releaseOrcadLiveSourceControlsUnderAuthority } from './orcad-live-source-control-release'
import { bindOutgoingOrcadIncumbent } from './orcad-outgoing-source-binding'
import { inspectOrcadLiveSourceOutputSettlements } from './orcad-live-source-output-settlement'
import { inspectOrcadLiveCatalogActivationCohort } from './orcad-live-destination-activation'
import { reconfirmOrcadLiveCleanupDestination } from './orcad-live-cleanup-destination-authority'
import { completeOrcadLiveRuntimeSurfaceCleanup } from './orcad-live-runtime-cleanup'
import { OrcadLiveSourceRetirementRecordStore } from './orcad-live-source-retirement-record'
import {
  createOrcadLiveCleanupOutputEvidence,
  OrcadLiveCleanupOutputEvidenceStore
} from './orcad-live-cleanup-output-evidence'

type ReleaseOptions = Parameters<typeof releaseOrcadLiveSourceControlsUnderAuthority>[0]
type Released = Awaited<ReturnType<typeof releaseOrcadLiveSourceControlsUnderAuthority>>
type Source = ReturnType<typeof bindOutgoingOrcadIncumbent>
type Prepared = {
  profileDirectory: string
  record: Released['record']
  released?: Released
  sources: Pick<Source, 'provider' | 'providerGeneration' | 'ptyId'>[]
  cleanup?: ReturnType<OrcaRuntimeService['prepareOutgoingSshPtyGraphAndModelCleanup']>
}

const preparedByRuntime = new WeakMap<object, Map<string, Prepared>>()

/** Resumes in-process cleanup with fresh authority; a restart requires durable reconstruction. */
export async function cleanupOrcadLiveSourceRuntime(
  options: Omit<ReleaseOptions, 'record' | 'pairingCode' | 'assertAuthority' | 'runtime'> & {
    migrationId: string
    runtime: ReleaseOptions['runtime'] &
      Pick<OrcaRuntimeService, 'prepareOutgoingSshPtyGraphAndModelCleanup'>
  }
) {
  return withOrcadCommittedProfileAuthority(options, async (authority) => {
    const recovery = inspectOrcadLiveRetirementRecovery(
      options.profileDirectory,
      options.store
    ).find((entry) => entry.record.release.cutover.manifest.migrationId === options.migrationId)
    if (recovery?.state !== 'profile-installed') {
      throw new Error('orcad_live_control_release_installed_profile_required')
    }
    const { record } = recovery
    const records = new OrcadLiveSourceRetirementRecordStore(options.profileDirectory)
    const assertProfile = () => {
      options.signal.throwIfAborted()
      authority.assertAuthority()
      if (
        serializeOrcadMigrationValue(records.read(record.identity)) !==
        serializeOrcadMigrationValue(record)
      ) {
        throw new Error('orcad_live_control_release_evidence_changed')
      }
      const profile = options.store.inspectOrcadLiveRetirementProfileState(record)
      if (profile.state !== 'profile-installed') {
        throw new Error('orcad_live_control_release_installed_profile_required', {
          cause:
            profile.state === 'conflict' ? profile.diagnostic : { reason: 'profile-not-installed' }
        })
      }
    }
    assertProfile()
    const sources = record.release.cutover.liveTerminalBindings!.map(({ identity }) =>
      bindOutgoingOrcadIncumbent({
        identity,
        ptyId: toAppSshPtyId(
          record.release.cutover.manifest.source.sshTargetId,
          identity.terminalId
        ),
        sourceSshTargetId: record.release.cutover.manifest.source.sshTargetId,
        signal: options.signal,
        assertAuthority: assertProfile
      })
    )
    let operations = preparedByRuntime.get(options.runtime)
    if (!operations) {
      operations = new Map()
      preparedByRuntime.set(options.runtime, operations)
    }
    let prepared = operations.get(options.migrationId)
    if (!prepared) {
      // Missing runtime objects cannot prove that a previous attempt cleaned them up.
      if (recovery.cleanupPrepared || recovery.runtimeCleanupRecorded) {
        throw new Error('orcad_live_runtime_cleanup_restart_reconstruction_required')
      }
      prepared = {
        profileDirectory: options.profileDirectory,
        record,
        sources: sources.map(({ provider, providerGeneration, ptyId }) => ({
          provider,
          providerGeneration,
          ptyId
        }))
      }
      operations.set(options.migrationId, prepared)
    }
    const operation = prepared
    if (
      operation.profileDirectory !== options.profileDirectory ||
      serializeOrcadMigrationValue(operation.record) !== serializeOrcadMigrationValue(record)
    ) {
      throw new Error('orcad_live_runtime_cleanup_prepared_identity_changed')
    }
    const assertSources = () => {
      assertProfile()
      for (const [index, source] of sources.entries()) {
        source.assertIncumbent()
        const previous = operation.sources[index]
        if (
          previous?.provider !== source.provider ||
          previous.providerGeneration !== source.providerGeneration ||
          previous.ptyId !== source.ptyId
        ) {
          throw new Error('orcad_live_runtime_cleanup_incumbent_changed')
        }
      }
    }
    assertSources()
    operation.released ??= await releaseOrcadLiveSourceControlsUnderAuthority({
      ...options,
      ...authority,
      record,
      assertAuthority: assertSources
    })
    const released = operation.released
    const outputs = new OrcadLiveCleanupOutputEvidenceStore(options.profileDirectory)
    const outputEvidence = createOrcadLiveCleanupOutputEvidence(
      record,
      released.sourceOutputSettlements
    )
    const assertCurrent = () => {
      assertSources()
      if (
        sources.some((source) => !source.provider.isOutgoingSourceControlReleased?.(source.ptyId))
      ) {
        throw new Error('orcad_live_control_release_unconfirmed')
      }
      const output = inspectOrcadLiveSourceOutputSettlements(sources, assertProfile)
      if (
        serializeOrcadMigrationValue(output) !==
        serializeOrcadMigrationValue(released.sourceOutputSettlements)
      ) {
        throw new Error('orcad_live_source_output_changed')
      }
    }
    assertCurrent()
    await reconfirmOrcadLiveCleanupDestination({
      ...options,
      ...authority,
      cutover: record.release.cutover,
      destinationRuntimeId: record.identity.destinationRuntimeId,
      assertCurrent
    })
    const activated = await inspectOrcadLiveCatalogActivationCohort({
      ...options,
      ...authority,
      cutover: record.release.cutover,
      assertCurrent
    })
    assertCurrent()
    if (
      serializeOrcadMigrationValue(activated.activations) !==
      serializeOrcadMigrationValue(released.activations)
    ) {
      throw new Error('orcad_live_control_release_activation_changed')
    }
    const assertCleanupAuthority = () => {
      assertCurrent()
      if (
        serializeOrcadMigrationValue(outputs.read(record.identity)) !==
        serializeOrcadMigrationValue(outputEvidence)
      ) {
        throw new Error('orcad_live_cleanup_output_evidence_changed')
      }
    }
    outputs.persist(outputEvidence)
    assertCleanupAuthority()
    operation.cleanup ??= options.runtime.prepareOutgoingSshPtyGraphAndModelCleanup(
      record.release.cutover.manifest.source.sshTargetId
    )
    return completeOrcadLiveRuntimeSurfaceCleanup({
      ...options,
      record,
      cleanup: operation.cleanup,
      assertAuthority: assertCleanupAuthority
    })
  })
}
