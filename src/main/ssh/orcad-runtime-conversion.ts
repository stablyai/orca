/**
 * Converting a relay-hosted SSH target that holds Orca state into a managed orcad server:
 * fence the source, deploy and pair the server, stage and commit the dormant catalog, then
 * retire the source.
 *
 * Every step is keyed by the journal, so calling this again after a crash or lost contact resumes
 * the same migration instead of starting another. The source stays authoritative until the
 * destination proves its commit, and only then is retired.
 */
import { randomUUID } from 'node:crypto'
import type { OrcadManagedConversionResult } from '../../shared/orcad-managed-runtime'
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import { recordManagedOrcadMigration } from '../../shared/runtime-environment-managed-orcad-store'
import { listEnvironments } from '../../shared/runtime-environment-store'
import {
  redactRuntimeEnvironment,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { runTargetLifecycle } from '../ipc/ssh-target-lifecycle-queue'
import { environmentMatchesManagedOrcadCutover } from './orcad-managed-migration-status'
import { requireManagedOrcadInfrastructure } from './orcad-managed-runtime-context'
import { ensureOrcadManagedTunnel } from './orcad-managed-tunnel'
import {
  commitOrcadMigrationDestination,
  type OrcadMigrationDestinationCatalog
} from './orcad-migration-cutover-coordinator'
import {
  fenceOrcadMigrationSource,
  resolveOrcadMigrationFence
} from './orcad-migration-source-fence'
import {
  assessOrcadMigrationTerminals,
  type ListRelayPtyIds
} from './orcad-migration-terminal-gate'
import { createManagedOrcadEnvironment } from './orcad-runtime-deployment'
import { retireOrcadMigrationSource } from './orcad-migration-source-retirement'
import {
  isOrcadSourceRetirementEnabled,
  retainOrcadMigrationSource
} from './orcad-migration-source-retention'
import { hasRegisteredDirectSshAuthority } from './ssh-target-registry'

export type OrcadManagedConversionArgs = {
  sshTargetId: string
  name: string
  /** The relay's process list, asked while the host is still connected directly. */
  listRelayPtyIds: ListRelayPtyIds | null
  /** The destination's T6-9 catalog client, reached through the server's tunnel. */
  destinationFor: (environment: KnownRuntimeEnvironment) => OrcadMigrationDestinationCatalog
  /** Releases the direct SSH session after the terminal check, before the fence. */
  releaseDirectSession: (sshTargetId: string) => Promise<void>
  now?: () => Date
  signal?: AbortSignal
  /** Whether to retire the source after commit; defaults to the `orcad-source-retirement` flag. */
  retireSource?: () => boolean
}

export async function convertSshTargetToManagedOrcad(
  userDataPath: string,
  args: OrcadManagedConversionArgs
): Promise<OrcadManagedConversionResult> {
  const fenced = await fenceOrResume(userDataPath, args)
  if ('outcome' in fenced) {
    return fenced
  }
  const deployed = await createManagedOrcadEnvironment(userDataPath, {
    name: fenced.destinationName,
    sshTargetId: fenced.sshTargetId,
    migration: true,
    signal: args.signal
  })
  if (deployed.outcome === 'deferred') {
    return deployed // The fence and journal stay; a later call resumes here.
  }
  const environment = listEnvironments(userDataPath).find(
    (entry) => entry.id === fenced.destinationEnvironmentId
  )
  if (!environment || !environmentMatchesManagedOrcadCutover(environment, fenced)) {
    throw new Error('orcad_migration_destination_environment_mismatch')
  }
  // Before any commit can land, so a crash after it still blocks rollbacks across it.
  const marked = recordManagedOrcadMigration(
    userDataPath,
    environment.id,
    (args.now ?? (() => new Date()))().toISOString()
  )
  await ensureOrcadManagedTunnel(userDataPath, environment.id)
  const { claims, targetStore } = requireManagedOrcadInfrastructure()
  const committed = await runTargetLifecycle(fenced.sshTargetId, () =>
    commitOrcadMigrationDestination(
      {
        userDataPath,
        store: targetStore.getOrcadMigrationSource(),
        claims,
        destination: args.destinationFor(marked),
        now: args.now
      },
      fenced.migrationId
    )
  )
  if (committed.phase !== 'destination-committed' && committed.phase !== 'source-retired') {
    throw new Error(`orcad_migration_commit_not_proven:${committed.phase}`)
  }
  if (
    committed.phase === 'destination-committed' &&
    !(args.retireSource ?? isOrcadSourceRetirementEnabled)()
  ) {
    retainOrcadMigrationSource(userDataPath, committed.migrationId, args.now)
  } else {
    await runTargetLifecycle(fenced.sshTargetId, () =>
      retireOrcadMigrationSource(
        {
          userDataPath,
          store: targetStore.getOrcadMigrationSource(),
          environment: marked,
          now: args.now,
          signal: args.signal
        },
        committed.migrationId
      )
    )
  }
  return {
    outcome: 'converted',
    environment: redactRuntimeEnvironment(marked),
    migrationId: committed.migrationId
  }
}

async function fenceOrResume(
  userDataPath: string,
  args: OrcadManagedConversionArgs
): Promise<
  OrcadMigrationSourceCutover | Extract<OrcadManagedConversionResult, { outcome: 'refused' }>
> {
  const { claims, targetStore } = requireManagedOrcadInfrastructure()
  const target = targetStore.getTarget(args.sshTargetId)
  if (!target) {
    return refuse('unverifiable', 'orcad_migration_target_not_found', 'The SSH host is gone.')
  }
  const existing = resolveOrcadMigrationFence(userDataPath, target)
  if (existing.state === 'fenced') {
    return existing.cutover
  }
  const converted = listEnvironments(userDataPath).some(
    (environment) => environment.orcadDeployment?.sshTargetId === target.id
  )
  if (converted) {
    return refuse(
      'live',
      'orcad_migration_already_managed',
      'This SSH host is already a managed server.'
    )
  }
  const store = targetStore.getOrcadMigrationSource()
  // Asked while the relay still answers; the fence re-checks leases once it holds.
  const terminalProof = await assessOrcadMigrationTerminals(store, target.id, args.listRelayPtyIds)
  if (terminalProof.verdict !== 'exited') {
    return refuse(terminalProof.verdict, 'orcad_migration_terminals', terminalProof.reason)
  }
  await args.releaseDirectSession(target.id)
  const result = await runTargetLifecycle(target.id, () =>
    fenceOrcadMigrationSource({
      userDataPath,
      store,
      claims,
      targetId: target.id,
      destinationEnvironmentId: randomUUID(),
      destinationName: args.name,
      terminalProof,
      hasDirectSshAuthority: hasRegisteredDirectSshAuthority,
      now: args.now,
      signal: args.signal
    })
  )
  if (result.outcome === 'fenced') {
    return result.cutover
  }
  if (result.blockers?.length) {
    // Why logged: the connect surfaces only the reason, and support needs which state blocked.
    console.warn(
      '[ssh] Conversion refused by:',
      JSON.stringify(
        result.blockers.map((blocker) =>
          'dependencies' in blocker
            ? { code: blocker.code, dependencies: blocker.dependencies }
            : { code: blocker.code }
        )
      )
    )
  }
  return refuse(result.verdict, result.code, result.reason)
}

function refuse(
  verdict: 'live' | 'unverifiable',
  code: string,
  reason: string
): Extract<OrcadManagedConversionResult, { outcome: 'refused' }> {
  return { outcome: 'refused', verdict, code, reason }
}
