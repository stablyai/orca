// Resume journaled migrations after lost contact; source rows stay authoritative until proven commit.
// Retain source rows afterwards for downgrade compatibility.
import { randomUUID } from 'node:crypto'
import type { OrcadManagedConversionResult } from '../../../shared/orcad-managed-runtime'
import type { OrcadMigrationSourceCutover } from '../../../shared/orcad-migration/orcad-migration-source-cutover'
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
} from '../../ssh/targets/ssh-target-orcad-preflight'
import { ORCAD_MIGRATION_LEAVE_BEHIND_TERMINALS_REASON } from '../../ssh/orcad-migration-source-fence'
import type { OrcadMigrationPaneLeasePredicate } from '../../ssh/orcad-migration-bridged-panes'
import { retainOrcadMigrationSource } from '../../ssh/orcad-migration-source-retention'
import {
  enableMovedOrcadAutomations,
  type EnableServerAutomation
} from '../../ssh/orcad-migration-moved-automations'
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
  censusHost?: ((target: SshTarget) => ReturnType<CensusHostRelayTerminals>) | null
  isBridgedPaneLease?: OrcadMigrationPaneLeasePredicate
  destinationFor: (environment: KnownRuntimeEnvironment) => OrcadMigrationDestinationCatalog
  /** Link matching host paths to existing server projects. */
  serverRepositoriesFor?: (environment: KnownRuntimeEnvironment) => Promise<OrcadServerRepository[]>
  /** Link folder workspaces already present from earlier moves. */
  serverFolderCatalogFor?: (
    environment: KnownRuntimeEnvironment
  ) => Promise<OrcadServerFolderCatalog>
  releaseDirectSession?: (sshTargetId: string) => Promise<void>
  /** Re-enables moved automations that ran on this desktop. */
  serverAutomationEnablerFor?: (environment: KnownRuntimeEnvironment) => EnableServerAutomation
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
    return deployed // Retain fence and journal for a later resume.
  }
  const environment = listEnvironments(userDataPath).find(
    (entry) => entry.id === fenced.destinationEnvironmentId
  )
  if (!environment || !environmentMatchesManagedOrcadCutover(environment, fenced)) {
    throw new Error('orcad_migration_destination_environment_mismatch')
  }
  // Record before commit so crashes cannot allow rollback across migrated state.
  recordManagedOrcadMigration(
    userDataPath,
    environment.id,
    (args.now ?? (() => new Date()))().toISOString()
  )
  // Tunnel repair may replace pairing credentials; use its returned environment for every request.
  const marked = await ensureOrcadManagedTunnel(userDataPath, environment.id)
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
  let automationsLeftDisabled = 0
  if (committed.phase === 'destination-committed') {
    await retainOrcadMigrationSource(userDataPath, committed.migrationId, store, args.now)
    if (args.serverAutomationEnablerFor) {
      automationsLeftDisabled = await enableMovedOrcadAutomations(
        userDataPath,
        committed.migrationId,
        args.serverAutomationEnablerFor(marked)
      ).catch((error: unknown) => {
        console.warn('[ssh] Could not re-enable moved automations:', error)
        return 0
      })
    }
  }
  const linkedProjects = linkedOrcadMigrationProjects(store, linked)
  return {
    outcome: 'converted',
    environment: redactRuntimeEnvironment(marked),
    migrationId: committed.migrationId,
    ...(linkedProjects.length > 0 ? { linkedProjects } : {}),
    ...(automationsLeftDisabled > 0 ? { automationsLeftDisabled } : {})
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
    censusHost: censusHost ? () => censusHost(target) : null,
    isBridgedPaneLease: args.isBridgedPaneLease
  })
  const existing = source.resolveFence()
  if (existing.state === 'fenced') {
    return existing.cutover
  }
  const stale = existing.state === 'stale-journal' ? existing.cutover : null
  if (stale && !isRegistered(userDataPath, stale.destinationEnvironmentId)) {
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
    return refuse('live', 'orcad_migration_already_managed', 'Orca already runs on this SSH host.')
  }
  // Source fencing rechecks leases after acquisition.
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
    // Surface blocked state in logs because connect shows only the summary reason.
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
  const leavable =
    result.blockers &&
    onlyLeavableOrcadMigrationBlockers(result.blockers) &&
    !target.managedServerLeaveBehind
  const canLeaveBehind =
    leavable &&
    leaveBehindClearsOrcadMigrationBlockers(
      store,
      target.id,
      terminalProof.verdict === 'bridged' ? terminalProof.bridgedPtyIds : [],
      args.isBridgedPaneLease
    )
  if (leavable && terminalProof.verdict !== 'exited' && !canLeaveBehind) {
    // Leaving tabs behind would strand terminals still served by the legacy bridge.
    return refuse(
      result.verdict,
      result.code,
      `${result.reason} ${ORCAD_MIGRATION_LEAVE_BEHIND_TERMINALS_REASON}`
    )
  }
  return {
    ...refuse(result.verdict, result.code, result.reason),
    // Preview confirmation to avoid offering an export the confirmed path would refuse.
    ...(canLeaveBehind ? { canLeaveBehind: true } : {})
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
