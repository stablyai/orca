/**
 * The signed manifest a local WSL move carries into the distro's orcad (mover design, section 2).
 *
 * Reads only. The same dormant-state collectors the SSH conversion uses, through a local-WSL scope,
 * then the UNC→Linux rewrite. Anything those collectors cannot carry comes back as a blocker: a move
 * refuses instead of dropping a row. Deterministic for one store state and request, so the driver can
 * re-export under the fence and compare digests.
 */
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { resolveFolderWorkspaceHost } from '../../../shared/folder-workspace-execution-host'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type {
  OrcadMigrationCatalogPayload,
  OrcadMigrationLocalWslManifestSource,
  OrcadMigrationManifest
} from '../../../shared/orcad-migration/orcad-migration-manifest'
import {
  ORCAD_MIGRATION_MANIFEST_VERSION,
  parseOrcadMigrationManifest
} from '../../../shared/orcad-migration/orcad-migration-manifest-validation'
import { withoutOrcadRetainedMarker } from '../../../shared/orcad-retained-marker'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId, getRepoMainWorktreeId } from '../../../shared/worktree/id'
import { computeOrcadMigrationManifestSha256 } from '../../orcad/orcad-migration-manifest-digest'
import { hasDormantState } from '../../ssh/orcad-migration-manifest-export'
import {
  rewriteOrcadMigrationPayloadPaths,
  rewriteOrcadMigrationWorktreeId
} from '../../ssh/orcad-migration-path-rewrite'
import type { Store } from '../../persistence'
import { compareKeys } from '../migrating-orcad-catalog/orcad-source-key-order'
import { wslUncPathToLinux } from '../../../shared/wsl-paths'
import { createUncToLinuxPathRewriter } from './wsl-move-path-rewriter'

export type WslMoveManifestExportRequest = {
  migrationId: string
  now: () => Date
  distro: string
  /** The host record's registry id, when known. */
  distroGuid?: string
  /** The `wsl:<distro>` environment id. */
  destinationEnvironmentId: string
  /** planWslMove's plan.generation. */
  generation: number
  /** plan.repoIds: the exact scope. */
  repoIds: readonly string[]
  folderWorkspaceIds: readonly string[]
}

export type WslMoveManifestExport = {
  /** Signed; its source scope is exactly the request's, its paths rewritten to the distro's. */
  manifest: OrcadMigrationManifest
  /** User-facing reasons for state the manifest cannot carry. Non-empty: the driver refuses. */
  blockers: string[]
  /** What the Sleep relay takes: every worktree id and `folder:<id>` key in scope (UNC form). */
  workspaceIds: string[]
  /** The same workspaces as pty session ids mint them: worktree ids and `folder:<id>` keys. */
  workspaceKeys: string[]
  /** For shell-history blobs: each UNC worktree id and the Linux one the host holds. */
  worktrees: { sourceWorktreeId: string; destinationWorktreeId: string }[]
  /** Moved disabled (the wire carries no enabled automation); re-enable on the host after commit. */
  automationsToReenable: string[]
}

/** The plan names a project or folder that is no longer a local row of this distro. */
export class WslMoveScopeChangedError extends Error {
  constructor(readonly missingIds: readonly string[]) {
    super('Some projects in this move changed since it was planned. Review the move again.')
    this.name = 'WslMoveScopeChangedError'
  }
}

export type WslMoveManifestExportStore = Pick<
  Store,
  | 'getRepos'
  | 'getFolderWorkspaces'
  | 'getProjectGroups'
  | 'inspectOrcadMigrationSourceDormantState'
>

const DORMANT_KIND_WORDS: Record<string, string> = {
  'worktree-metadata': 'saved workspace details',
  'worktree-lineage': 'workspace history',
  'workspace-lineage': 'workspace history',
  'workspace-session': 'saved tabs and panes',
  automation: 'automations',
  'automation-run': 'automation run history',
  'sparse-preset': 'sparse checkout presets',
  'retired-worktree-name': 'retired workspace names',
  'mobile-tab-selection': 'phone tab selections',
  'ui-routing': 'sidebar settings',
  'saved-port-forward': 'saved port forwards'
}

export function exportWslMoveManifest(
  store: WslMoveManifestExportStore,
  request: WslMoveManifestExportRequest
): WslMoveManifestExport {
  const blockers: string[] = []
  const missing: string[] = []
  // The retained mark is this desktop's record; the host must never receive it.
  const repos = pickLocalRows(store.getRepos(), request.repoIds, isLocalRepo, (id) =>
    missing.push(id)
  ).map(withoutOrcadRetainedMarker)
  const allGroups = store.getProjectGroups()
  const allFolders = store.getFolderWorkspaces()
  const folderWorkspaces = pickLocalRows(
    allFolders,
    request.folderWorkspaceIds,
    (workspace) =>
      resolveFolderWorkspaceHost(
        { repos: store.getRepos(), projectGroups: allGroups, folderWorkspaces: [workspace] },
        workspace.id
      ).kind === 'local',
    (id) => missing.push(id)
  ).map(withoutOrcadRetainedMarker)
  // The signed scope must name exactly the rows it carries: a stale plan is replanned, not signed.
  if (missing.length > 0) {
    throw new WslMoveScopeChangedError(missing)
  }
  const catalog: OrcadMigrationCatalogPayload = {
    repositories: repos,
    projectGroups: referencedGroups(allGroups, [...repos, ...folderWorkspaces]),
    folderWorkspaces
  }
  const source: OrcadMigrationLocalWslManifestSource = {
    kind: 'local-wsl',
    distro: request.distro,
    ...(request.distroGuid ? { distroGuid: request.distroGuid } : {}),
    scopeRepoIds: [...request.repoIds],
    scopeFolderWorkspaceIds: [...request.folderWorkspaceIds],
    generation: request.generation
  }
  const inspection = store.inspectOrcadMigrationSourceDormantState(
    source,
    catalog,
    request.destinationEnvironmentId
  )
  blockers.push(...inspection.blockedSessionItems, ...inspection.leftBehindItems)
  for (const [kind, count] of Object.entries(inspection.blockedCounts)) {
    if (count > 0 && kind !== 'workspace-session') {
      blockers.push(
        `${count} ${DORMANT_KIND_WORDS[kind] ?? kind} can't move with this project yet.`
      )
    }
  }
  const dormantState = inspection.payload
  const rewriter = createUncToLinuxPathRewriter(request.distro)
  const payload = rewriteOrcadMigrationPayloadPaths(
    { ...catalog, ...(hasDormantState(dormantState) ? { dormantState } : {}) },
    rewriter
  )
  const unsigned = {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId: request.migrationId,
    createdAt: request.now().toISOString(),
    source,
    payload,
    destinationEnvironmentId: request.destinationEnvironmentId
  }
  const manifest = parseOrcadMigrationManifest({
    ...unsigned,
    manifestSha256: computeOrcadMigrationManifestSha256(unsigned)
  })
  const worktreeIds = scopedWorktreeIds(repos, { ...catalog, dormantState })
  const workspaceKeys = [
    ...worktreeIds,
    ...folderWorkspaces.map((workspace) => `folder:${workspace.id}`).sort(compareKeys)
  ]
  return {
    manifest,
    blockers,
    workspaceIds: workspaceKeys,
    workspaceKeys,
    worktrees: worktreeIds.map((sourceWorktreeId) => ({
      sourceWorktreeId,
      destinationWorktreeId: rewriteOrcadMigrationWorktreeId(sourceWorktreeId, rewriter)
    })),
    automationsToReenable: inspection.automationsEnabledAtSource
  }

  function isLocalRepo(repo: Repo): boolean {
    return (
      getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID &&
      wslUncPathToLinux(repo.path, request.distro) !== null
    )
  }
}

/** The scope's own rows, in store order; another host's row of the same id is never taken. */
function pickLocalRows<T extends { id: string }>(
  rows: readonly T[],
  ids: readonly string[],
  isLocal: (row: T) => boolean,
  onMissing: (id: string) => void
): T[] {
  const wanted = new Set(ids)
  const picked = rows.filter((row) => wanted.has(row.id) && isLocal(row))
  const found = new Set(picked.map((row) => row.id))
  for (const id of ids) {
    if (!found.has(id)) {
      onMissing(id)
    }
  }
  return picked.map((row) => structuredClone(row))
}

/** Groups the moved rows sit in, with their ancestors; copied, so rows left here keep theirs. */
function referencedGroups(
  groups: readonly ProjectGroup[],
  rows: readonly (Pick<Repo, 'projectGroupId'> | Pick<FolderWorkspace, 'projectGroupId'>)[]
): ProjectGroup[] {
  const byId = new Map(groups.map((group) => [group.id, group]))
  const taken = new Set<string>()
  for (const row of rows) {
    let id: string | null | undefined = row.projectGroupId
    while (id && !taken.has(id) && byId.has(id)) {
      taken.add(id)
      id = byId.get(id)?.parentGroupId
    }
  }
  return groups.filter((group) => taken.has(group.id)).map((group) => structuredClone(group))
}

/** Every worktree id in scope the store names: each repo's main worktree and any saved for it. */
function scopedWorktreeIds(
  repos: readonly Repo[],
  payload: OrcadMigrationCatalogPayload
): string[] {
  const repoIds = new Set(repos.map((repo) => repo.id))
  const ids = new Set(repos.map((repo) => getRepoMainWorktreeId(repo)))
  const dormant = payload.dormantState
  const named = [
    ...(dormant?.worktreeMeta.map((row) => row.worktreeId) ?? []),
    ...(dormant?.worktreeLineage.map((row) => row.worktreeId) ?? []),
    ...Object.keys(dormant?.workspaceSession?.tabsByWorktree ?? {}),
    ...Object.keys(dormant?.workspaceSession?.openFilesByWorktree ?? {})
  ]
  for (const key of named) {
    const workspace = parseWorkspaceKey(key)
    const worktreeId = workspace?.type === 'worktree' ? workspace.worktreeId : key
    if (workspace?.type !== 'folder' && repoIds.has(getRepoIdFromWorktreeId(worktreeId))) {
      ids.add(worktreeId)
    }
  }
  return [...ids].sort(compareKeys)
}
