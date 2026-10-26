/** Link same-host-path checkouts to existing server rows without overwriting their newer state; retain desktop source copies. Re-journal under the same id only after proving the prior manifest absent, preventing duplicate imports. */
import { getAutomationRunRepoId } from '../../shared/automation-run-identity'
import type { Automation } from '../../shared/automations-types'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { isRepoOnCatalogHost } from '../../shared/execution-host'
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration/orcad-migration-source-cutover'
import type { Repo } from '../../shared/repo-types'
import type { SshManagedServerLinkedProject } from '../../shared/ssh-types'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { splitWorktreeId } from '../../shared/worktree/id'
import type { Store } from '../persistence'
import {
  abortOrcadMigrationCutover,
  type OrcadMigrationDestinationCatalog
} from './orcad-migration-cutover-coordinator'
import { writeOrcadMigrationSourceCutover } from './orcad-migration-cutover-journal'
import { orcadSourceStoreWithout, type OrcadDeltaSourceStore } from './orcad-migration-delta-plan'
import { createOrcadMigrationManifest } from './orcad-migration-manifest-export'
import type { OrcadMigrationSourceCutoverPort } from './orcad-migration-source'
import { sshRelayMigrationCutoverPort } from './orcad-migration-ssh-relay-source'
import { orcadCatalogFingerprint } from './orcad-retained-source'
import {
  folderWorkspacesHeldByServer,
  type OrcadServerFolderCatalog
} from './orcad-server-folder-workspaces'
import { projectGroupsHeldByServer, serverHeldProjectGroups } from './orcad-server-project-groups'
import type { SshTargetOrcadClaims } from './targets/ssh-target-orcad-claims'

export type OrcadServerRepository = Pick<Repo, 'id' | 'path'> & {
  connectionId?: string | null
  executionHostId?: string | null
  /** Proves the server holds this group: its record, not this desktop's copy, wins on relink. */
  projectGroupId?: string | null
}

/** Match only server-local checkouts. Same-id rows can survive earlier moves into stopped-server profiles (#29560); nested remote rows identify different hosts. */
export function repositoriesHeldByServer(
  incoming: readonly OrcadServerRepository[],
  server: readonly OrcadServerRepository[]
): { otherId: string[]; sameId: string[] } {
  const serverIdsByPath = new Map<string, Set<string>>()
  for (const repo of server.filter(isRepoOnCatalogHost)) {
    const key = normalizeRuntimePathForComparison(repo.path)
    serverIdsByPath.set(key, (serverIdsByPath.get(key) ?? new Set()).add(repo.id))
  }
  const otherId: string[] = []
  const sameId: string[] = []
  for (const repo of incoming) {
    const ids = serverIdsByPath.get(normalizeRuntimePathForComparison(repo.path))
    if (ids?.has(repo.id)) {
      sameId.push(repo.id)
    } else if (ids) {
      otherId.push(repo.id)
    }
  }
  return { otherId, sameId }
}

/** Link older same-id imports so retained desktop state cannot overwrite server edits. A commit awaiting journal update must resume instead. */
async function serverHeldRowsToLink(
  cutover: OrcadMigrationSourceCutover,
  destination: OrcadMigrationDestinationCatalog,
  server: readonly OrcadServerRepository[],
  serverFolders: OrcadServerFolderCatalog
): Promise<{ repositoryIds: string[]; folderWorkspaceIds: string[]; projectGroupIds: string[] }> {
  const { payload } = cutover.manifest
  const held = repositoriesHeldByServer(payload.repositories, server)
  const heldFolders = folderWorkspacesHeldByServer(payload.folderWorkspaces, serverFolders, server)
  const heldGroups = projectGroupsHeldByServer(payload.projectGroups, serverFolders)
  const otherIdOnly = { repositoryIds: held.otherId, folderWorkspaceIds: [], projectGroupIds: [] }
  if (held.sameId.length === 0 && heldFolders.length === 0 && heldGroups.length === 0) {
    return otherIdOnly
  }
  const state = await destination.readState(cutover.manifest)
  return state.state === 'committed'
    ? otherIdOnly
    : {
        repositoryIds: [...held.otherId, ...held.sameId],
        folderWorkspaceIds: heldFolders,
        projectGroupIds: heldGroups
      }
}

function linkedOrcadMigrationSource(
  store: Store,
  cutover: Pick<
    OrcadMigrationSourceCutover,
    | 'sshTargetId'
    | 'destinationEnvironmentId'
    | 'linkedRepositoryIds'
    | 'linkedProjectGroupIds'
    | 'linkedFolderWorkspaceIds'
  >
): (() => OrcadDeltaSourceStore) | undefined {
  const linked = cutover.linkedRepositoryIds ?? []
  const linkedGroups = cutover.linkedProjectGroupIds ?? []
  const linkedFolders = cutover.linkedFolderWorkspaceIds ?? []
  if (linked.length === 0 && linkedGroups.length === 0 && linkedFolders.length === 0) {
    return undefined
  }
  return () => {
    const target = store.getSshTarget(cutover.sshTargetId)
    if (!target) {
      throw new Error('orcad_migration_source_fence_lost')
    }
    return orcadSourceStoreWithout(
      store,
      target,
      {
        repositoryIds: new Set(linked),
        folderWorkspaceIds: new Set(linkedFolders),
        projectGroupIds: new Set()
      },
      cutover.destinationEnvironmentId,
      new Set(linkedGroups)
    )
  }
}

export function linkedOrcadMigrationCutoverPort(args: {
  userDataPath: string
  store: Store
  claims: SshTargetOrcadClaims
  cutover: OrcadMigrationSourceCutover
}): OrcadMigrationSourceCutoverPort {
  return sshRelayMigrationCutoverPort({
    userDataPath: args.userDataPath,
    store: args.store,
    claims: args.claims,
    freshSource: linkedOrcadMigrationSource(args.store, args.cutover)
  })
}

const NO_SERVER_FOLDERS: OrcadServerFolderCatalog = { folderWorkspaces: [], projectGroups: [] }

function leaseWorkspaceOwner(worktreeId: string): string | undefined {
  const scope = parseWorkspaceKey(worktreeId)
  return scope?.type === 'folder' ? scope.folderWorkspaceId : splitWorktreeId(worktreeId)?.repoId
}

/** Linking omits the original tab; refuse if the relay bridge still needs it or a live shell would be stranded. */
function assertNoRelayTerminalsIn(
  store: Pick<Store, 'getSshRemotePtyLeases'>,
  cutover: OrcadMigrationSourceCutover,
  linked: readonly string[],
  linkedFolders: readonly string[]
): void {
  const bridged = new Set(cutover.bridgedPtyIds ?? [])
  const owners = store
    .getSshRemotePtyLeases(cutover.sshTargetId)
    .filter((lease) => bridged.has(lease.ptyId) && lease.state !== 'terminated')
    .map((lease) => (lease.worktreeId ? leaseWorkspaceOwner(lease.worktreeId) : undefined))
  if (owners.length === 0) {
    return
  }
  const { repositories, folderWorkspaces } = cutover.manifest.payload
  const linkedRows = [
    ...repositories.filter((repo) => linked.includes(repo.id)),
    ...folderWorkspaces
      .filter((workspace) => linkedFolders.includes(workspace.id))
      .map((workspace) => ({ id: workspace.id, path: workspace.folderPath }))
  ]
  const blocked = linkedRows.find((row) => owners.includes(row.id))
  if (blocked) {
    throw new Error(`orcad_migration_linked_project_terminals:${blocked.path}`)
  }
  const moving = new Set([...repositories, ...folderWorkspaces].map((row) => row.id))
  // A lease whose project can't be told, or isn't moving, may be one a link would strand.
  if (owners.some((owner) => owner === undefined || !moving.has(owner))) {
    throw new Error(
      `orcad_migration_linked_project_unowned_terminals:${linkedRows.map((row) => row.path).join(', ')}`
    )
  }
}

export function linkedOrcadMigrationProjects(
  store: {
    getRepos(): OrcadServerRepository[]
    getFolderWorkspaces(): Pick<FolderWorkspace, 'id' | 'folderPath'>[]
    listAutomations(): Pick<Automation, 'projectId' | 'runContext'>[]
  },
  cutover: Pick<OrcadMigrationSourceCutover, 'linkedRepositoryIds' | 'linkedFolderWorkspaceIds'>
): SshManagedServerLinkedProject[] {
  const linked = new Set(cutover.linkedRepositoryIds ?? [])
  const linkedFolders = new Set(cutover.linkedFolderWorkspaceIds ?? [])
  if (linked.size === 0 && linkedFolders.size === 0) {
    return []
  }
  const automations = store.listAutomations()
  return [
    ...store
      .getRepos()
      .filter((repo) => linked.has(repo.id))
      .map((repo) => ({
        path: repo.path,
        automations: automations.filter((entry) => getAutomationRunRepoId(entry) === repo.id).length
      })),
    ...store
      .getFolderWorkspaces()
      .filter((workspace) => linkedFolders.has(workspace.id))
      .map((workspace) => ({ path: workspace.folderPath, automations: 0 }))
  ]
}

export async function linkServerHeldRepositories(args: {
  userDataPath: string
  store: Store
  claims: SshTargetOrcadClaims
  cutover: OrcadMigrationSourceCutover
  destination: OrcadMigrationDestinationCatalog
  serverRepositories: () => Promise<OrcadServerRepository[]>
  /** Absent: the server's folder workspaces aren't read, so none of them link. */
  serverFolderCatalog?: () => Promise<OrcadServerFolderCatalog>
  now?: () => Date
}): Promise<OrcadMigrationSourceCutover> {
  const { cutover, userDataPath } = args
  if (cutover.phase !== 'source-fenced' && cutover.phase !== 'destination-staged') {
    return cutover
  }
  const serverRepositories = await args.serverRepositories()
  const { folderWorkspaces, projectGroups } = cutover.manifest.payload
  const serverCatalog =
    folderWorkspaces.length > 0 || projectGroups.length > 0
      ? await args.serverFolderCatalog?.()
      : undefined
  const serverFolders = serverCatalog ?? NO_SERVER_FOLDERS
  const {
    repositoryIds: linked,
    folderWorkspaceIds: folders,
    projectGroupIds: heldGroups
  } = await serverHeldRowsToLink(cutover, args.destination, serverRepositories, serverFolders)
  if (linked.length === 0 && folders.length === 0 && heldGroups.length === 0) {
    return cutover
  }
  assertNoRelayTerminalsIn(args.store, cutover, linked, folders)
  const source = linkedOrcadMigrationCutoverPort(args)
  // Re-export only after verifying the original fenced source still matches.
  source.verifyFence(cutover)
  const linkedRepositoryIds = [...new Set([...(cutover.linkedRepositoryIds ?? []), ...linked])]
  const linkedFolderWorkspaceIds = [
    ...new Set([...(cutover.linkedFolderWorkspaceIds ?? []), ...folders])
  ]
  const linkedProjectGroupIds = [
    ...new Set([
      ...(cutover.linkedProjectGroupIds ?? []),
      ...serverHeldProjectGroups(
        cutover.manifest.payload,
        {
          repositoryIds: new Set(linkedRepositoryIds),
          folderWorkspaceIds: new Set(linkedFolderWorkspaceIds)
        },
        [...serverRepositories, ...serverFolders.folderWorkspaces],
        serverCatalog
      )
    ])
  ]
  const linkedIds = {
    ...(linkedRepositoryIds.length > 0 ? { linkedRepositoryIds } : {}),
    ...(linkedProjectGroupIds.length > 0 ? { linkedProjectGroupIds } : {}),
    ...(linkedFolderWorkspaceIds.length > 0 ? { linkedFolderWorkspaceIds } : {})
  }
  const view = linkedOrcadMigrationSource(args.store, { ...cutover, ...linkedIds })?.()
  const target = args.store.getSshTarget(cutover.sshTargetId)
  if (!view || !target) {
    throw new Error('orcad_migration_source_fence_lost')
  }
  const manifest = createOrcadMigrationManifest(view, target, {
    migrationId: cutover.migrationId,
    destinationEnvironmentId: cutover.destinationEnvironmentId,
    now: () => new Date(cutover.manifest.createdAt)
  })
  const relinked: OrcadMigrationSourceCutover = {
    ...cutover,
    phase: 'source-fenced',
    updatedAt: (args.now ?? (() => new Date()))().toISOString(),
    manifestSha256: manifest.manifestSha256,
    manifest,
    ...linkedIds,
    // Retained rows include linked projects, so baseline the entire fenced source.
    sourceBaselineFingerprint:
      cutover.sourceBaselineFingerprint ?? orcadCatalogFingerprint(cutover.manifest.payload)
  }
  const aborted = await abortOrcadMigrationCutover(
    { userDataPath, store: args.store, claims: args.claims, destination: args.destination, source },
    cutover.migrationId,
    // Relinking continues the same move/server, so retain its fence.
    async () => writeOrcadMigrationSourceCutover(userDataPath, relinked)
  )
  if (aborted.outcome !== 'released') {
    throw new Error(aborted.code)
  }
  return relinked
}
