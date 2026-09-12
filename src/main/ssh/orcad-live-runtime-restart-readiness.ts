import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { withOrcadCommittedProfileAuthority } from './orcad-committed-profile-authority'
import { inspectOrcadLiveRetirementRecovery } from './orcad-live-retirement-recovery-inspection'
import { OrcadLiveSourceRetirementRecordStore } from './orcad-live-source-retirement-record'
import {
  createOrcadLiveSourceCleanupIntent,
  OrcadLiveSourceCleanupIntentStore
} from './orcad-live-source-cleanup-intent'
import {
  createOrcadLiveCleanupOutputEvidence,
  OrcadLiveCleanupOutputEvidenceStore
} from './orcad-live-cleanup-output-evidence'
import { reconfirmOrcadLiveCleanupDestination } from './orcad-live-cleanup-destination-authority'
import { inspectOrcadLiveCatalogActivationCohort } from './orcad-live-destination-activation'
import {
  assertOrcadLiveSourceReleaseCompatible,
  parseOrcadLiveSourceReleaseIntent
} from './orcad-live-source-release-intent'

type Activation = Awaited<ReturnType<typeof inspectOrcadLiveCatalogActivationCohort>>
type OutputEvidence = ReturnType<typeof createOrcadLiveCleanupOutputEvidence>

/** Holds current authority for recovery work; readiness alone records no cleanup or route release. */
export async function withOrcadLiveRuntimeRestartReadiness<T>(
  options: {
    profileDirectory: string
    store: Store
    migrationId: string
    runtime: Pick<OrcaRuntimeService, 'bindOutgoingSshPtySurfaceAbsence'>
    signal: AbortSignal
    allowCompleted?: boolean
    remote?: Parameters<typeof reconfirmOrcadLiveCleanupDestination>[0]['remote']
    activate?: Parameters<typeof inspectOrcadLiveCatalogActivationCohort>[0]['activate']
  },
  operation: (context: {
    pairingCode: string
    record: NonNullable<ReturnType<OrcadLiveSourceRetirementRecordStore['read']>>
    outputEvidence: OutputEvidence
    activations: Activation['activations']
    assertCurrent: () => void
    transitionCompletedJournal: (candidate: unknown, write: () => void) => void
  }) => Promise<T>
) {
  return withOrcadCommittedProfileAuthority(options, async (authority) => {
    const recovery = inspectOrcadLiveRetirementRecovery(
      options.profileDirectory,
      options.store
    ).find((entry) => entry.record.release.cutover.manifest.migrationId === options.migrationId)
    if (
      recovery?.state !== 'profile-installed' ||
      !recovery.cleanupPrepared ||
      !recovery.sourceOutputSettlementRecorded
    ) {
      throw new Error('orcad_live_runtime_restart_evidence_required')
    }
    const { record } = recovery
    const records = new OrcadLiveSourceRetirementRecordStore(options.profileDirectory)
    const preparations = new OrcadLiveSourceCleanupIntentStore(options.profileDirectory)
    const outputs = new OrcadLiveCleanupOutputEvidenceStore(options.profileDirectory)
    const outputEvidence = createOrcadLiveCleanupOutputEvidence(
      record,
      outputs.read(record.identity)?.settlements
    )
    const expected = serializeOrcadMigrationValue({
      record,
      preparation: createOrcadLiveSourceCleanupIntent(record),
      outputEvidence
    })
    const assertEvidence = () => {
      options.signal.throwIfAborted()
      authority.assertAuthority()
      const profile = options.store.inspectOrcadLiveRetirementProfileState(record)
      if (
        profile.state !== 'profile-installed' ||
        serializeOrcadMigrationValue({
          record: records.read(record.identity),
          preparation: preparations.read(record.identity),
          outputEvidence: outputs.read(record.identity)
        }) !== expected
      ) {
        throw new Error('orcad_live_runtime_restart_evidence_changed', {
          cause:
            profile.state === 'conflict'
              ? profile.diagnostic
              : {
                  reason:
                    profile.state === 'profile-installed'
                      ? 'retained-evidence'
                      : 'profile-not-installed'
                }
        })
      }
    }
    assertEvidence()
    const targetId = record.release.cutover.manifest.source.sshTargetId
    const absence = options.runtime.bindOutgoingSshPtySurfaceAbsence(
      targetId,
      record.release.cutover.liveTerminalBindings!.map(({ identity, surfaceBinding }) => ({
        ptyId: toAppSshPtyId(targetId, identity.terminalId),
        surfaceBinding
      }))
    )
    let active = true
    const assertCurrent = () => {
      if (!active) {
        throw new Error('orcad_live_runtime_restart_authority_released')
      }
      assertEvidence()
      absence.assertAbsent()
    }
    try {
      assertCurrent()
      await reconfirmOrcadLiveCleanupDestination({
        ...options,
        ...authority,
        cutover: record.release.cutover,
        destinationRuntimeId: record.identity.destinationRuntimeId,
        assertCurrent
      })
      const current = await inspectOrcadLiveCatalogActivationCohort({
        ...options,
        ...authority,
        cutover: record.release.cutover,
        assertCurrent
      })
      assertCurrent()
      assertOrcadLiveSourceReleaseCompatible(
        parseOrcadLiveSourceReleaseIntent({
          version: 1,
          cutover: current.cutover,
          activations: current.activations
        }),
        record.release
      )
      const result = await operation({
        pairingCode: authority.pairingCode,
        record: structuredClone(record),
        outputEvidence: structuredClone(outputEvidence),
        activations: structuredClone(current.activations),
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
