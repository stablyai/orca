/**
 * A move onto a server another desktop on the same login already uses. A project this desktop moves
 * that the server already holds at the same host path is the same checkout, so the move links it
 * to the server's project instead of importing a second row the server refuses. The server's row
 * and state stay as they are; this desktop's own rows stay in its retained source, as moved ones do.
 *
 * Linking rewrites the journal under the same migration id, and only after the server proves it
 * holds nothing of the earlier manifest, so no row ever lands twice.
 */
import { getAutomationRunRepoId } from '../../shared/automation-run-identity'
import type { Automation } from '../../shared/automations-types'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { isRepoOnCatalogHost } from '../../shared/execution-host'
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
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
import type { SshTargetOrcadClaims } from './ssh-target-orcad-claims'

export type OrcadServerRepository = Pick<Repo, 'id' | 'path'> & {
  connectionId?: string | null
  executionHostId?: string | null
  /** Proves the server holds this group: its record, not this desktop's copy, wins on relink. */
  projectGroupId?: string | null
}

/**
 * Incoming projects the server holds at the same host path. `sameId` is the server's copy of this
 * desktop's own row, from an earlier move into the profile a stopped server left (#29560). Only the
 * server machine's own rows count: one it reaches on another host is a different checkout.
 */
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

/**
 * The server's same-id rows came from an earlier move unless this one already committed (a crash
 * before the journal caught up), which must resume, not relink. Its live state since then is
 * newer than this desktop's retained copy, so it is linked rather than re-imported over.
 */
async function serverHeldRowsToLink(
  cutover: OrcadMigrationSourceCutover,
  destination: OrcadMigrationDestinationCatalog,
  server: readonly OrcadServerRepository[],
  serverFolders: OrcadServerFolderCatalog
): Promise<{ repositoryIds: string[]; folderWorkspaceIds: string[] }> {
  const { payload } = cutover.manifest
  const held = repositoriesHeldByServer(payload.repositories, server)
  const heldFolders = folderWorkspacesHeldByServer(payload.folderWorkspaces, serverFolders, server)
  if (held.sameId.length === 0 && heldFolders.length === 0) {
    return { repositoryIds: held.otherId, folderWorkspaceIds: [] }
  }
  const state = await destination.readState(cutover.manifest)
  return state.state === 'committed'
    ? { repositoryIds: held.otherId, folderWorkspaceIds: [] }
    : { repositoryIds: [...held.otherId, ...held.sameId], folderWorkspaceIds: heldFolders }
}

/**
 * Source groups the server's projects sit in, and their ancestors, renamed there perhaps since:
 * re-importing this desktop's retained copy would conflict with the server's. An ancestor the
 * server may lack still moves while a moving row needs it.
 */
function serverHeldProjectGroups(
  payload: OrcadMigrationSourceCutover['manifest']['payload'],
  linked: { repositoryIds: ReadonlySet<string>; folderWorkspaceIds: ReadonlySet<string> },
  server: readonly { projectGroupId?: string | null }[]
): string[] {
  const parentById = new Map(payload.projectGroups.map((group) => [group.id, group.parentGroupId]))
  const held = new Set(server.flatMap((row) => (row.projectGroupId ? [row.projectGroupId] : [])))
  const withAncestors = (ids: (string | null | undefined)[], stopAt: ReadonlySet<string>) => {
    const out = new Set<string>()
    while (ids.length > 0) {
      const id = ids.pop()
      if (id && !out.has(id) && !stopAt.has(id) && parentById.has(id)) {
        out.add(id)
        ids.push(parentById.get(id))
      }
    }
    return out
  }
  const candidates = withAncestors([...held], new Set())
  const needed = withAncestors(
    [
      ...payload.repositories
        .filter((repo) => !linked.repositoryIds.has(repo.id))
        .map((repo) => repo.projectGroupId),
      ...payload.folderWorkspaces
        .filter((workspace) => !linked.folderWorkspaceIds.has(workspace.id))
        .map((workspace) => workspace.projectGroupId),
      ...payload.projectGroups
        .filter((group) => !candidates.has(group.id))
        .map((group) => group.parentGroupId)
    ],
    held
  )
  return [...candidates].filter((id) => !needed.has(id))
}

/** The source the cutover was cut from: the real store less any project or group it linked. */
export function linkedOrcadMigrationSource(
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

/** The repo or folder workspace a lease's tab belongs to. */
function leaseWorkspaceOwner(worktreeId: string): string | undefined {
  const scope = parseWorkspaceKey(worktreeId)
  return scope?.type === 'folder' ? scope.folderWorkspaceId : splitWorktreeId(worktreeId)?.repoId
}

/**
 * A relay terminal the bridge still serves reattaches only into its own tab, which a linked
 * project never sends to the server: linking now would strand it out of sight, still running.
 */
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

/** What each linked project leaves behind on this desktop, so the connect can say so. */
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

/** Returns the cutover to commit: the same one, or one re-journaled without the linked projects. */
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
  const serverFolders =
    cutover.manifest.payload.folderWorkspaces.length > 0
      ? ((await args.serverFolderCatalog?.()) ?? NO_SERVER_FOLDERS)
      : NO_SERVER_FOLDERS
  const { repositoryIds: linked, folderWorkspaceIds: folders } = await serverHeldRowsToLink(
    cutover,
    args.destination,
    serverRepositories,
    serverFolders
  )
  if (linked.length === 0 && folders.length === 0) {
    return cutover
  }
  assertNoRelayTerminalsIn(args.store, cutover, linked, folders)
  const source = linkedOrcadMigrationCutoverPort(args)
  // The relinked manifest is cut from the source as fenced, so it must still be that source.
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
        [...serverRepositories, ...serverFolders.folderWorkspaces]
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
    // The retained rows still hold the linked projects, so the baseline is the whole fenced source.
    sourceBaselineFingerprint:
      cutover.sourceBaselineFingerprint ?? orcadCatalogFingerprint(cutover.manifest.payload)
  }
  const aborted = await abortOrcadMigrationCutover(
    { userDataPath, store: args.store, claims: args.claims, destination: args.destination, source },
    cutover.migrationId,
    // Why keep the fence: the move goes on to the same server, now without the linked projects.
    async () => writeOrcadMigrationSourceCutover(userDataPath, relinked)
  )
  if (aborted.outcome !== 'released') {
    throw new Error(aborted.code)
  }
  return relinked
}
