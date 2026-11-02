import {
  agentSessionExecutionLocationsEqual,
  type AgentSessionExecutionLocation
} from '../../../shared/agent-session/lifecycle/agent-session-record'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../shared/execution-host'
import { createFolderWorkspaceHostIndex } from '../../../shared/folder-workspace-host-index'
import { createRepoRowExecutionHostLookup } from '../../../shared/worktree-execution-host-resolution'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import { isFolderRepo } from '../../../shared/repo-kind'
import type { Repo } from '../../../shared/repo-types'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import {
  composeWorktreeId,
  getRepoMainWorktreeId,
  splitWorktreeIdForFilesystem
} from '../../../shared/worktree/id'
import { areWorktreePathsEqual, canonicalWorktreePath } from '../../git/worktree-path-comparison'
import { listWslMovedProjects } from '../../persistence/moving-wsl-projects/wsl-moved-projects'
import type { RuntimeWorktreeScanResult } from '../repo-worktree-resolution-scan'
import type { RuntimeStore } from '../runtime-store-contract'
import { resolveLocalProjectRuntimesForRepos } from '../../local-project-runtime-resolution'
import { getLocalProjectWorktreeGitOptionsForRuntime } from '../../project-runtime-git-options'
import { StructuredWorkspaceUnavailable } from './structured-workspace-authority'

type Target = {
  worktree: Pick<ResolvedWorktree, 'id' | 'path' | 'repoId' | 'hostId'>
  executionHostId: AgentSessionExecutionLocation['executionHostId']
}

type Runtimes = ReturnType<typeof resolveLocalProjectRuntimesForRepos>

/** One nomination pass's catalog facts for deriving each candidate's location. */
export type StructuredLocationRouting = {
  repos: readonly Repo[]
  lookup: ReturnType<typeof createRepoRowExecutionHostLookup<Repo>>
  runtimes: Runtimes
}

type DiscoveryDeps = {
  store: RuntimeStore
  /** The shared catalog's listing, scanning only when its entry is missing or stale. */
  scan: (repo: Repo, runtimes?: Runtimes) => Promise<RuntimeWorktreeScanResult>
  /** The shared catalog's current fresh entry, without scanning; null when it has none. */
  listing: (repo: Repo, runtimes?: Runtimes) => RuntimeWorktreeScanResult | null
  locate: (target: Target, routing: StructuredLocationRouting) => AgentSessionExecutionLocation
  folderTarget: (folder: FolderWorkspace) => Target['worktree']
}

/** The source's registration is gone on its host, so only a same-directory destination can hold it. */
export function isRetiredStructuredSessionSource(
  store: RuntimeStore,
  location: AgentSessionExecutionLocation
): boolean {
  const source = splitWorktreeIdForFilesystem(location.workspaceId)
  return (
    !!source &&
    !store
      .getRepos()
      .some(
        (repo) =>
          repo.id === source.repoId && getRepoExecutionHostId(repo) === location.executionHostId
      )
  )
}

// One indexed pass over the current catalog: roots and scoped folders at the directory, and every
// Git owner in the record's own namespace that could list it.
function catalog(store: RuntimeStore, location: AgentSessionExecutionLocation) {
  const repos = store.getRepos()
  const folders = store.getFolderWorkspaces?.() ?? []
  const projectGroups = store.getProjectGroups?.() ?? []
  const moved = new Set(listWslMovedProjects(repos, folders).map((row) => `${row.kind}\0${row.id}`))
  const local = location.executionHostId === LOCAL_EXECUTION_HOST_ID
  const available = repos.filter(
    (repo) =>
      getRepoExecutionHostId(repo) === location.executionHostId &&
      !(local && moved.has(`repo\0${repo.id}`))
  )
  const gitOwners = available.filter((repo) => !isFolderRepo(repo))
  // Every local registration's runtime, since a candidate's distro comes from its own.
  const runtimes = resolveLocalProjectRuntimesForRepos(store, repos)
  // An owner proven to run Git in another distro (or natively) lists only checkouts of that
  // namespace; one whose runtime is unresolved could list this one, so it still counts.
  const owners = gitOwners.filter((owner) => {
    const runtime = runtimes.get(owner.id)
    return (
      !local ||
      runtime?.status === 'repair-required' ||
      (getLocalProjectWorktreeGitOptionsForRuntime(owner, runtime).wslDistro ?? null) ===
        location.wslDistro
    )
  })
  let hostIndex: ReturnType<typeof createFolderWorkspaceHostIndex<FolderWorkspace>> | undefined
  return {
    available,
    owners,
    runtimes,
    // One routing index for every candidate's location, not one per candidate.
    routing: { repos, lookup: createRepoRowExecutionHostLookup(repos), runtimes },
    folders: folders.filter((folder) => !(local && moved.has(`folder\0${folder.id}`))),
    qualify: (id: string) =>
      (hostIndex ??= createFolderWorkspaceHostIndex({
        folderWorkspaces: folders,
        projectGroups,
        repos
      }))(id, location.executionHostId)
  }
}

/** Nominate from current registrations and the catalog's fresh owner listings; decide only after coalescing. */
export async function discoverStructuredSessionDestination(
  deps: DiscoveryDeps,
  location: AgentSessionExecutionLocation
) {
  const source = splitWorktreeIdForFilesystem(location.workspaceId)!
  // Remote hosts keep their own path rules; only this machine's comparison may fold /private/tmp.
  const platform = location.executionHostId === LOCAL_EXECUTION_HOST_ID ? process.platform : 'linux'
  const samePath = (path: string) => areWorktreePathsEqual(path, source.worktreePath, platform)
  // Synchronous, so the rebind receipt re-runs it over whatever the catalog holds at commit.
  const nominate = (): AgentSessionExecutionLocation => {
    if (!isRetiredStructuredSessionSource(deps.store, location)) {
      throw new StructuredWorkspaceUnavailable('obsolete')
    }
    const current = catalog(deps.store, location)
    const candidates = new Map<string, AgentSessionExecutionLocation>()
    const add = (registration: string, worktree: Target['worktree']) => {
      const candidate = deps.locate(
        { worktree, executionHostId: location.executionHostId },
        current.routing
      )
      if (candidate.wslDistro === location.wslDistro) {
        candidates.set(
          `${registration}\0${canonicalWorktreePath(worktree.path, platform)}`,
          candidate
        )
      }
      // Candidates are never withdrawn, so two distinct ones already settle the answer.
      if (candidates.size > 1) {
        throw new StructuredWorkspaceUnavailable('unknown')
      }
    }
    for (const repo of current.available) {
      if (samePath(repo.path)) {
        add(repo.id, {
          id: getRepoMainWorktreeId(repo),
          path: repo.path,
          repoId: repo.id,
          hostId: location.executionHostId
        })
      }
    }
    for (const owner of current.owners) {
      // A missing, replaced or expired listing could hide this directory: prepare afresh.
      const listing = deps.listing(owner, current.runtimes)
      if (!listing) {
        throw new StructuredWorkspaceUnavailable('obsolete')
      }
      if (!listing.ok) {
        throw new StructuredWorkspaceUnavailable('unknown')
      }
      for (const row of listing.worktrees) {
        if (samePath(row.path)) {
          // Git's spelling keys the catalog's workspace, so it replaces the registration spelling.
          add(owner.id, {
            id: composeWorktreeId(owner.id, row.path),
            path: row.path,
            repoId: owner.id,
            hostId: location.executionHostId
          })
        }
      }
    }
    for (const folder of current.folders) {
      // An explicit foreign host settles the row without resolving it.
      const explicit = parseExecutionHostId(folder.executionHostId)
      const explicitHost =
        explicit?.kind === 'ssh'
          ? toSshExecutionHostId(explicit.targetId)
          : explicit?.kind === 'runtime'
            ? toRuntimeExecutionHostId(explicit.environmentId)
            : explicit?.id
      if (
        !samePath(folder.folderPath) ||
        (explicitHost && explicitHost !== location.executionHostId)
      ) {
        continue
      }
      const selected = current.qualify(folder.id)
      if (selected.kind === 'selected' && selected.value.workspace === folder) {
        add(folderWorkspaceKey(folder.id), {
          ...deps.folderTarget(folder),
          id: folderWorkspaceKey(folder.id)
        })
      }
    }
    if (candidates.size !== 1) {
      throw new StructuredWorkspaceUnavailable('unknown')
    }
    return [...candidates.values()][0]
  }
  for (let attempt = 0; ; attempt++) {
    const { owners, runtimes } = catalog(deps.store, location)
    // A timed-out scan leaves no fresh entry, which nomination treats as unproven.
    await Promise.all(owners.map((owner) => withTimeout(deps.scan(owner, runtimes), 5_000, null)))
    try {
      const destination = nominate()
      return {
        destination,
        /** Commit-time proof from the catalog as it is now: same retired source, same one destination. */
        admit: () => {
          if (!agentSessionExecutionLocationsEqual(nominate(), destination)) {
            throw new StructuredWorkspaceUnavailable('obsolete')
          }
        }
      }
    } catch (error) {
      // Listings replaced or expired while scanning: rescan, a bounded number of times.
      if (
        !(error instanceof StructuredWorkspaceUnavailable) ||
        error.reason !== 'obsolete' ||
        attempt >= 2
      ) {
        throw error
      }
    }
  }
}
