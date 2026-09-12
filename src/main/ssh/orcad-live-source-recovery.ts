import type { Store } from '../persistence'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { inspectOrcadLiveCutoverRecovery } from './orcad-live-cutover-recovery-inspection'
import { withOutgoingOrcadAuthority } from './orcad-outgoing-authority'
import { bindOutgoingOrcadCatalogSource } from './orcad-outgoing-catalog-source'
import { recordOrcadLiveCutoverProgressDurably } from './orcad-live-cutover-progress'
import { assertOrcadLiveCutoverCurrent } from './orcad-live-cutover-current'
import type { OrcadLiveSourceCutoverContext } from './orcad-live-source-cutover'
import { inspectOrcadLiveRetirementRecovery } from './orcad-live-retirement-recovery-inspection'

/** Resume retained authority only; missing phase evidence never restarts initial admission. */
export async function withOrcadLiveSourceRecovery<T>(
  options: {
    profileDirectory: string
    store: Store
    migrationId: string
    runtime: Parameters<typeof bindOutgoingOrcadCatalogSource>[0]['runtime']
    signal: AbortSignal
  },
  operation: (context: OrcadLiveSourceCutoverContext) => Promise<T>
) {
  options.signal.throwIfAborted()
  const inspect = () => {
    const retirement = inspectOrcadLiveRetirementRecovery(
      options.profileDirectory,
      options.store
    ).find((entry) => entry.record.release.cutover.manifest.migrationId === options.migrationId)
    if (retirement && retirement.state !== 'prepared') {
      throw new Error('orcad_live_cutover_post_install_recovery_required')
    }
    const candidate = inspectOrcadLiveCutoverRecovery(options.profileDirectory, options.store).find(
      (entry) => entry.intent.manifest.migrationId === options.migrationId
    )
    if (!candidate?.journal) {
      throw new Error('orcad_live_cutover_phase_observation_required')
    }
    return candidate
  }
  const initial = inspect()
  const { intent } = initial
  const assertEvidence = () => {
    if (serializeOrcadMigrationValue(inspect().intent) !== serializeOrcadMigrationValue(intent)) {
      throw new Error('orcad_live_cutover_intent_conflict')
    }
  }
  return withOutgoingOrcadAuthority(
    options.profileDirectory,
    {
      binding: {
        version: 1,
        identity: intent.liveTerminalBindings![0].identity,
        destinationEnvironmentId: intent.destinationEnvironmentId,
        sourceSshTargetId: intent.manifest.source.sshTargetId,
        sourceSshTargetGeneration: intent.manifest.source.sshTargetGeneration
      },
      sourceCutoverMigrationId: options.migrationId,
      signal: options.signal,
      assertEvidence
    },
    async (authority) => {
      authority.assertSourceCutoverOwner('fenced')
      const current = inspect().journal!
      const sourceAdmission = bindOutgoingOrcadCatalogSource({
        targetId: intent.manifest.source.sshTargetId,
        identities: intent.liveTerminalBindings!.map((entry) => entry.identity),
        runtime: options.runtime,
        store: options.store,
        signal: options.signal,
        assertAuthority: authority.assertAuthority
      })
      assertOrcadLiveCutoverCurrent({
        ...options,
        cutover: current,
        sourceAdmission,
        assertAuthority: authority.assertAuthority
      })
      const cutover = await recordOrcadLiveCutoverProgressDurably({
        ...options,
        next: current,
        assertAuthority: authority.assertAuthority
      })
      assertOrcadLiveCutoverCurrent({
        ...options,
        cutover,
        sourceAdmission,
        assertAuthority: authority.assertAuthority
      })
      const result = await operation({
        cutover,
        pairingCode: authority.pairingCode,
        assertAuthority: authority.assertAuthority,
        sourceAdmission
      })
      authority.assertAuthority()
      return result
    }
  )
}
