import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { runtimeEnvironmentSshAccessBinding } from '../../shared/runtime-environment-authority-binding'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { isPtyOwnershipTransferMutationEnabled } from '../../shared/pty-ownership-transfer-release-gate'
import { parsePtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import type { OrcadLiveMigrationProgress } from '../../shared/orcad-live-migration-recovery'
import { getSshPtyProvider } from '../ipc/pty/provider/registry'
import { inspectOrcadLiveCutoverRecovery } from './orcad-live-cutover-recovery-inspection'
import { withOrcadLiveSourceCutover } from './orcad-live-source-cutover'
import { migrateOrcadLiveDestination } from './orcad-live-destination-coordinator'
import {
  resumeSelectedOrcadLiveMigration,
  type OrcadLiveMigrationContext
} from './orcad-live-migration-selection'

const startSelection = z.object({
  selector: z.string().trim().min(1).max(1024),
  targetId: z.string().trim().min(1).max(1024)
})

/** Main owns cohort identity; renderer selections cannot mint transfer authority. */
export async function startSelectedOrcadLiveMigration(
  profileDirectory: string,
  context: OrcadLiveMigrationContext,
  selection: z.infer<typeof startSelection>,
  signal: AbortSignal
): Promise<OrcadLiveMigrationProgress> {
  const assertEnabled = () => {
    signal.throwIfAborted()
    if (!isPtyOwnershipTransferMutationEnabled()) {
      throw new Error('pty_ownership_transfer_mutation_disabled')
    }
  }
  assertEnabled()
  const args = startSelection.parse(selection)
  const environment = resolveEnvironment(profileDirectory, args.selector)
  const environmentId = environment.id
  const runtimeId = environment.runtimeId
  if (!runtimeId) {
    throw new Error('orcad_live_migration_destination_changed')
  }
  const destination = serializeOrcadMigrationValue(runtimeEnvironmentSshAccessBinding(environment))
  const assertDestination = () => {
    assertEnabled()
    const current = resolveEnvironment(profileDirectory, environmentId)
    if (
      current.id !== environmentId ||
      serializeOrcadMigrationValue(runtimeEnvironmentSshAccessBinding(current)) !== destination
    ) {
      throw new Error('orcad_live_migration_destination_changed')
    }
  }
  const retained = inspectOrcadLiveCutoverRecovery(profileDirectory, context.store).find(
    ({ intent }) => intent.manifest.source.sshTargetId === args.targetId
  )
  if (
    retained &&
    (retained.intent.destinationEnvironmentId !== environmentId ||
      retained.intent.liveTerminalBindings!.some(
        ({ identity }) => identity.destinationRuntimeId !== runtimeId
      ))
  ) {
    throw new Error('orcad_live_migration_destination_changed')
  }
  if (retained?.state === 'phase-unverifiable') {
    throw new Error('orcad_live_cutover_phase_observation_required')
  }
  const migrationId = retained?.intent.manifest.migrationId ?? randomUUID()
  if (!retained?.journal) {
    let identities = retained?.intent.liveTerminalBindings!.map(({ identity }) => identity)
    if (!identities) {
      const inventory = context.runtime.bindOutgoingSshPtyCatalogSurfaces(args.targetId)
      const provider = getSshPtyProvider(args.targetId)
      if (!inventory.surfaces.length || !provider?.getOwnershipTransferSourceIdentity) {
        throw new Error('orcad_outgoing_capture_source_unavailable')
      }
      identities = inventory.surfaces.map(({ ptyId, incarnationId, surfaceBinding }) => {
        const source = provider.getOwnershipTransferSourceIdentity!(ptyId)
        if (
          !source ||
          source.terminalId !== surfaceBinding.ptyId ||
          source.incarnationId !== incarnationId
        ) {
          throw new Error('orcad_outgoing_catalog_source_inventory_mismatch')
        }
        return parsePtyOwnershipTransferWireIdentity({
          ...source,
          bridgeId: randomUUID(),
          destinationRuntimeId: runtimeId
        })
      })
      inventory.assertCurrent()
    }
    assertDestination()
    await withOrcadLiveSourceCutover(
      {
        ...context,
        profileDirectory,
        selector: environmentId,
        targetId: args.targetId,
        migrationId,
        identities,
        signal,
        assertEvidence: assertDestination
      },
      (captured) => {
        const assertAuthority = () => {
          assertDestination()
          captured.assertAuthority()
        }
        assertAuthority()
        return migrateOrcadLiveDestination({
          ...context,
          profileDirectory,
          signal,
          ...captured,
          assertAuthority
        })
      }
    )
  }
  // Resume reacquires the same lifecycle locks; the admission callback must finish first.
  assertDestination()
  const result = await resumeSelectedOrcadLiveMigration(
    profileDirectory,
    context,
    { selector: environmentId, migrationId, mode: 'initial' },
    signal
  )
  assertDestination()
  return result
}
