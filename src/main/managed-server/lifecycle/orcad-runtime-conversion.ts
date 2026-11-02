/**
 * Converting a relay-hosted SSH target that holds Orca state into a managed orcad server:
 * fence the source, deploy and pair the server, stage and commit the dormant catalog, then keep
 * the source rows, hidden, for a downgraded build.
 *
 * Every step is keyed by the journal, so calling this again after a crash or lost contact resumes
 * the same migration instead of starting another. The source stays authoritative until the
 * destination proves its commit, and is never deleted afterwards.
 */
import { randomUUID } from 'node:crypto'
import type { OrcadManagedConversionResult } from '../../../shared/orcad-managed-runtime'
import type { OrcadMigrationSourceCutover } from '../../../shared/orcad-migration-source-cutover'
import { recordManagedOrcadMigration } from '../../../shared/runtime-environment-managed-orcad-store'
import { listEnvironments } from '../../../shared/runtime-environment-store'
import {
  getOrcadSshDeployment,
  redactRuntimeEnvironment,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import { runTargetLifecycle } from '../../ipc/ssh/ssh-target-lifecycle-queue'
import { environmentMatchesManagedOrcadCutover } from './orcad-managed-migration-status'
import { requireManagedOrcadInfrastructure } from './orcad-managed-runtime-context'
import { ensureOrcadManagedTunnel } from './orcad-managed-tunnel'
import {
  commitOrcadMigrationDestination,
  type OrcadMigrationDestinationCatalog
} from '../../ssh/orcad-migration-cutover-coordinator'
import {
  findOrcadMigrationSourceCutoverForTarget,
  removeOrcadMigrationJournalsForDestination
} from '../../ssh/orcad-migration-cutover-journal'
import type { SshTarget } from '../../../shared/ssh-types'
import type { CensusHostRelayTerminals } from '../../ssh/orcad-migration-terminal-gate'
import { createManagedOrcadEnvironment } from './orcad-runtime-deployment'
import { createSshRelayMigrationSource } from '../../ssh/orcad-migration-ssh-relay-source'
import {
  leaveBehindClearsOrcadMigrationBlockers,
  onlyLeavableOrcadMigrationBlockers
} from '../../ssh/ssh-target-orcad-preflight'
import { ORCAD_MIGRATION_LEAVE_BEHIND_TERMINALS_REASON } from '../../ssh/orcad-migration-source-fence'
import { retainOrcadMigrationSource } from '../../ssh/orcad-migration-source-retention'
import {
  linkedOrcadMigrationCutoverPort,
  linkedOrcadMigrationProjects,
  linkServerHeldRepositories,
  type OrcadServerRepository
} from '../../ssh/orcad-migration-repository-link'
import type { OrcadServerFolderCatalog } from '../../ssh/orcad-server-folder-workspaces'

export type OrcadManagedConversionArgs = {
  sshTargetId: string
  name: string
  /** The census of the host's relay endpoints that must prove exit. */
  censusHost?: ((target: SshTarget) => ReturnType<CensusHostRelayTerminals>) | null
  /** The destination's T6-9 catalog client, reached through the server's tunnel. */
  destinationFor: (environment: KnownRuntimeEnvironment) => OrcadMigrationDestinationCatalog
  /** The server's own projects, so ones this host already holds at the same path link to them. */
  serverRepositoriesFor?: (environment: KnownRuntimeEnvironment) => Promise<OrcadServerRepository[]>
  /** The server's folder workspaces, so ones an earlier move left there link to them. */
  serverFolderCatalogFor?: (
    environment: KnownRuntimeEnvironment
  ) => Promise<OrcadServerFolderCatalog>
  /** Releases the direct SSH session after the terminal check, before the fence. */
  releaseDirectSession?: (sshTargetId: string) => Promise<void>
  now?: () => Date
  signal?: AbortSignal
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
  const store = targetStore.getOrcadMigrationSource()
  const destination = args.destinationFor(marked)
  const serverRepositoriesFor = args.serverRepositoriesFor
  const serverFolderCatalogFor = args.serverFolderCatalogFor
  let linked: Pick<
    OrcadMigrationSourceCutover,
    'linkedRepositoryIds' | 'linkedFolderWorkspaceIds'
  > = {}
  const committed = await runTargetLifecycle(fenced.sshTargetId, async () => {
    const journaled = requireJournaledCutover(userDataPath, fenced)
    const cutover = serverRepositoriesFor
      ? await linkServerHeldRepositories({
          userDataPath,
          store,
          claims,
          cutover: journaled,
          destination,
          serverRepositories: () => serverRepositoriesFor(marked),
          ...(serverFolderCatalogFor
            ? { serverFolderCatalog: () => serverFolderCatalogFor(marked) }
            : {}),
          now: args.now
        })
      : journaled
    linked = cutover
    return commitOrcadMigrationDestination(
      {
        userDataPath,
        store,
        claims,
        source: linkedOrcadMigrationCutoverPort({ userDataPath, store, claims, cutover }),
        destination,
        now: args.now
      },
      cutover.migrationId
    )
  })
  if (committed.phase !== 'destination-committed' && committed.phase !== 'source-retired') {
    throw new Error(`orcad_migration_commit_not_proven:${committed.phase}`)
  }
  if (committed.phase === 'destination-committed') {
    retainOrcadMigrationSource(userDataPath, committed.migrationId, args.now)
  }
  const linkedProjects = linkedOrcadMigrationProjects(store, linked)
  return {
    outcome: 'converted',
    environment: redactRuntimeEnvironment(marked),
    migrationId: committed.migrationId,
    ...(linkedProjects.length > 0 ? { linkedProjects } : {})
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
  const store = targetStore.getOrcadMigrationSource()
  const censusHost = args.censusHost
  const source = createSshRelayMigrationSource({
    userDataPath,
    store,
    claims,
    target,
    censusHost: censusHost ? () => censusHost(target) : null
  })
  const existing = source.resolveFence()
  if (existing.state === 'fenced') {
    return existing.cutover
  }
  const stale = existing.state === 'stale-journal' ? existing.cutover : null
  if (stale && !isRegistered(userDataPath, stale.destinationEnvironmentId)) {
    // Its fence is gone and its server unregistered, so nothing it records can still be acted on.
    removeOrcadMigrationJournalsForDestination(
      userDataPath,
      target.id,
      stale.destinationEnvironmentId
    )
  }
  const converted = listEnvironments(userDataPath).some(
    (environment) => getOrcadSshDeployment(environment)?.sshTargetId === target.id
  )
  if (converted) {
    return refuse(
      'live',
      'orcad_migration_already_managed',
      'This SSH host is already a managed server.'
    )
  }
  // The fence re-checks leases once it holds.
  const terminalProof = await source.assessTerminals()
  if (terminalProof.verdict === 'live' || terminalProof.verdict === 'unverifiable') {
    return refuse(terminalProof.verdict, 'orcad_migration_terminals', terminalProof.reason)
  }
  source.retireProvenExitedTerminals(terminalProof)
  await args.releaseDirectSession?.(target.id)
  const result = await runTargetLifecycle(target.id, () =>
    source.acquireFence({
      destinationEnvironmentId: randomUUID(),
      destinationName: args.name,
      terminalProof,
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
  // Already moving anyway: what still refuses is what can't be left behind.
  const leavable =
    result.blockers &&
    onlyLeavableOrcadMigrationBlockers(result.blockers) &&
    !target.managedServerLeaveBehind
  if (leavable && terminalProof.verdict !== 'exited') {
    // Why no offer: leaving tabs behind would strand terminals the relay bridge still serves.
    return refuse(
      result.verdict,
      result.code,
      `${result.reason} ${ORCAD_MIGRATION_LEAVE_BEHIND_TERMINALS_REASON}`
    )
  }
  return {
    ...refuse(result.verdict, result.code, result.reason),
    // Why previewed: an offer the confirmed export would refuse again is a dead end.
    ...(leavable && leaveBehindClearsOrcadMigrationBlockers(store, target.id)
      ? { canLeaveBehind: true }
      : {})
  }
}

function requireJournaledCutover(
  userDataPath: string,
  fenced: OrcadMigrationSourceCutover
): OrcadMigrationSourceCutover {
  const journaled = findOrcadMigrationSourceCutoverForTarget(userDataPath, fenced.sshTargetId)
  if (journaled?.migrationId !== fenced.migrationId) {
    throw new Error('orcad_migration_source_fence_lost')
  }
  return journaled
}

function isRegistered(userDataPath: string, environmentId: string): boolean {
  return listEnvironments(userDataPath).some((environment) => environment.id === environmentId)
}

function refuse(
  verdict: 'live' | 'unverifiable',
  code: string,
  reason: string
): Extract<OrcadManagedConversionResult, { outcome: 'refused' }> {
  return { outcome: 'refused', verdict, code, reason }
}
