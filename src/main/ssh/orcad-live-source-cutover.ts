import type { Store } from '../persistence'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { parsePtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { withOutgoingOrcadAuthority } from './orcad-outgoing-authority'
import { bindOutgoingOrcadCatalogSource } from './orcad-outgoing-catalog-source'
import { createOrcadMigrationManifest } from './orcad-migration-manifest-export'
import { beginOrcadLiveSourceCutoverDurably } from './orcad-live-cutover-admission'
import { inspectOrcadLiveCutoverRecovery } from './orcad-live-cutover-recovery-inspection'
import { assertOrcadLiveMigrationPreflight } from './orcad-live-migration-preflight'
import { prepareOrcadLiveProfileParticipation } from './orcad-live-profile-participation'
import { readCurrentProfileLifetimeParticipation } from './profile-lifetime-admission'

export type OrcadLiveSourceCutoverContext = {
  cutover: Awaited<ReturnType<typeof beginOrcadLiveSourceCutoverDurably>>
  pairingCode: string
  assertAuthority: () => void
  sourceAdmission: ReturnType<typeof bindOutgoingOrcadCatalogSource>
}

/** Continuation stays inside both lifecycle locks; do not re-enter per-terminal lock wrappers. */
export async function withOrcadLiveSourceCutover<T>(
  options: {
    profileDirectory: string
    store: Store
    selector: string
    targetId: string
    migrationId: string
    identities: readonly unknown[]
    runtime: Parameters<typeof bindOutgoingOrcadCatalogSource>[0]['runtime']
    signal: AbortSignal
    assertEvidence?: () => void
  },
  operation: (context: OrcadLiveSourceCutoverContext) => Promise<T>
) {
  options.signal.throwIfAborted()
  const identities = options.identities.map(parsePtyOwnershipTransferWireIdentity)
  const target = options.store.getSshTarget(options.targetId)
  const environment = resolveEnvironment(options.profileDirectory, options.selector)
  if (!target || !identities[0] || !options.migrationId.trim()) {
    throw new Error('orcad_live_cutover_source_unavailable')
  }
  let assertParticipation: (() => void) | undefined
  return withOutgoingOrcadAuthority(
    options.profileDirectory,
    {
      binding: {
        version: 1,
        identity: identities[0],
        destinationEnvironmentId: environment.id,
        sourceSshTargetId: target.id,
        sourceSshTargetGeneration: target.generation
      },
      sourceCutoverMigrationId: options.migrationId,
      signal: options.signal,
      assertEvidence: () => {
        options.assertEvidence?.()
        assertParticipation?.()
      }
    },
    async (authority) => {
      const sourceAdmission = bindOutgoingOrcadCatalogSource({
        targetId: target.id,
        identities,
        runtime: options.runtime,
        store: options.store,
        signal: options.signal,
        assertAuthority: authority.assertAuthority
      })
      const existing = inspectOrcadLiveCutoverRecovery(
        options.profileDirectory,
        options.store
      ).find((entry) => entry.intent.manifest.source.sshTargetId === target.id)
      if (
        existing &&
        (existing.intent.manifest.migrationId !== options.migrationId ||
          existing.intent.destinationEnvironmentId !== environment.id)
      ) {
        throw new Error('orcad_live_cutover_intent_conflict')
      }
      const manifest = createOrcadMigrationManifest(options.store, target, {
        migrationId: options.migrationId,
        destinationEnvironmentId: environment.id,
        projectLiveSource: sourceAdmission.projectSourceState,
        ...(existing ? { now: () => new Date(existing.intent.manifest.createdAt) } : {})
      })
      const intent = {
        version: 2,
        ...(existing?.intent.profileParticipationRequired ||
        (!existing && readCurrentProfileLifetimeParticipation())
          ? { profileParticipationRequired: true as const }
          : {}),
        phase: 'source-fenced',
        destinationEnvironmentId: environment.id,
        manifest,
        liveTerminalBindings: sourceAdmission.bindings,
        startedAt: existing?.intent.startedAt ?? manifest.createdAt,
        updatedAt: existing?.intent.updatedAt ?? manifest.createdAt
      }
      await assertOrcadLiveMigrationPreflight({
        targetId: target.id,
        identities,
        pairingCode: authority.pairingCode,
        signal: options.signal,
        assertAuthority: sourceAdmission.assertCurrent
      })
      sourceAdmission.assertCurrent()
      assertParticipation = prepareOrcadLiveProfileParticipation({
        profileDirectory: options.profileDirectory,
        intent,
        assertAuthority: sourceAdmission.assertCurrent
      })
      const cutover = await beginOrcadLiveSourceCutoverDurably({
        profileDirectory: options.profileDirectory,
        store: options.store,
        intent,
        sourceAdmission,
        signal: options.signal,
        assertAuthority: authority.assertSourceCutoverOwner
      })
      sourceAdmission.assertCurrent()
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
