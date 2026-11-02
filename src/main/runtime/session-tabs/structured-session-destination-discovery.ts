import type { AgentSessionExecutionLocation } from '../../../shared/agent-session/lifecycle/agent-session-record'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../shared/execution-host'
import { resolveQualifiedFolderWorkspaceResult } from '../../../shared/folder-workspace-execution-host'
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
import {
  getLocalWorktreeScanGeneration,
  isLocalWorktreeScanGenerationCurrent
} from '../../local-worktree-scan-generation'
import { listWslMovedProjects } from '../../persistence/moving-wsl-projects/wsl-moved-projects'
import type { RuntimeWorktreeScanResult } from '../repo-worktree-resolution-scan'
import type { RuntimeStore } from '../runtime-store-contract'
import { scanUntilNotOvertaken } from '../../ipc/worktrees/listing/overtaken-scan-rerun'
import { resolveLocalProjectRuntimesForRepos } from '../../local-project-runtime-resolution'
import { StructuredWorkspaceUnavailable } from './structured-workspace-authority'

type Target = {
  worktree: Pick<ResolvedWorktree, 'id' | 'path' | 'repoId' | 'hostId'>
  executionHostId: AgentSessionExecutionLocation['executionHostId']
}

type DiscoveryDeps = {
  store: RuntimeStore
  scan: (
    repo: Repo,
    runtimes?: ReturnType<typeof resolveLocalProjectRuntimesForRepos>
  ) => Promise<RuntimeWorktreeScanResult>
  locate: (target: Target) => AgentSessionExecutionLocation
  folderTarget: (folder: FolderWorkspace) => Target['worktree']
}

const ownerKey = (repo: Repo) => `${getRepoExecutionHostId(repo)}\0${repo.id}\0${repo.path}`

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

// One indexed pass: roots and scoped folders at the directory, plus every Git owner that could list it.
function catalog(store: RuntimeStore, location: AgentSessionExecutionLocation) {
  const repos = store.getRepos()
  const folders = store.getFolderWorkspaces?.() ?? []
  const moved = new Set(listWslMovedProjects(repos, folders).map((row) => `${row.kind}\0${row.id}`))
  const local = location.executionHostId === LOCAL_EXECUTION_HOST_ID
  const available = repos.filter(
    (repo) =>
      getRepoExecutionHostId(repo) === location.executionHostId &&
      !(local && moved.has(`repo\0${repo.id}`))
  )
  const foldersById = new Map<string, FolderWorkspace[]>()
  for (const folder of folders) {
    foldersById.set(folder.id, [...(foldersById.get(folder.id) ?? []), folder])
  }
  return {
    repos,
    available,
    owners: available.filter((repo) => !isFolderRepo(repo)),
    folders: folders.filter((folder) => !(local && moved.has(`folder\0${folder.id}`))),
    foldersById,
    projectGroups: store.getProjectGroups?.() ?? []
  }
}

/** Nominate from current registrations and complete owner listings; decide only after coalescing. */
export async function discoverStructuredSessionDestination(
  deps: DiscoveryDeps,
  location: AgentSessionExecutionLocation
) {
  const source = splitWorktreeIdForFilesystem(location.workspaceId)!
  // Remote hosts keep their own path rules; only this machine's comparison may fold /private/tmp.
  const platform = location.executionHostId === LOCAL_EXECUTION_HOST_ID ? process.platform : 'linux'
  const samePath = (path: string) => areWorktreePathsEqual(path, source.worktreePath, platform)
  const scans = new Map<string, RuntimeWorktreeScanResult & { scanGeneration: number }>()
  const owners = catalog(deps.store, location).owners
  const runtimes = resolveLocalProjectRuntimesForRepos(deps.store, owners)
  await Promise.all(
    owners.map(async (owner) => {
      // The same generation witness and overtake bound as authority, minus its prune capture.
      const scan = await scanUntilNotOvertaken(
        owner.id,
        async () => {
          const scanGeneration = getLocalWorktreeScanGeneration(owner.id)
          const result = await withTimeout(deps.scan(owner, runtimes), 5_000, {
            ok: false,
            worktrees: []
          })
          const stale = !isLocalWorktreeScanGenerationCurrent(owner.id, scanGeneration)
          return { ...result, scanGeneration, superseded: result.ok && stale }
        },
        () => true
      )
      scans.set(ownerKey(owner), scan)
    })
  )
  const nominate = (): AgentSessionExecutionLocation => {
    if (!isRetiredStructuredSessionSource(deps.store, location)) {
      throw new StructuredWorkspaceUnavailable('obsolete')
    }
    const current = catalog(deps.store, location)
    const candidates = new Map<string, AgentSessionExecutionLocation>()
    const add = (registration: string, worktree: Target['worktree']) => {
      const candidate = deps.locate({ worktree, executionHostId: location.executionHostId })
      if (candidate.wslDistro === location.wslDistro) {
        candidates.set(
          `${registration}\0${canonicalWorktreePath(worktree.path, platform)}`,
          candidate
        )
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
      const scan = scans.get(ownerKey(owner))
      // An owner added, moved or rescanned since discovery could list the directory unseen.
      if (!scan || !isLocalWorktreeScanGenerationCurrent(owner.id, scan.scanGeneration)) {
        throw new StructuredWorkspaceUnavailable('obsolete')
      }
      if (!scan.ok) {
        throw new StructuredWorkspaceUnavailable('unknown')
      }
      for (const row of scan.worktrees) {
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
      // An explicit foreign host settles the row without resolving the rest of the catalog.
      const explicit = parseExecutionHostId(folder.executionHostId)
      const explicitHost =
        explicit?.kind === 'ssh'
          ? toSshExecutionHostId(explicit.targetId)
          : explicit?.kind === 'runtime'
            ? toRuntimeExecutionHostId(explicit.environmentId)
            : explicit?.id
      if (
        candidates.size > 1 ||
        !samePath(folder.folderPath) ||
        (explicitHost && explicitHost !== location.executionHostId)
      ) {
        continue
      }
      const selected = resolveQualifiedFolderWorkspaceResult(
        {
          repos: current.repos,
          folderWorkspaces: current.foldersById.get(folder.id),
          projectGroups: current.projectGroups
        },
        folder.id,
        location.executionHostId
      )
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
  const destination = nominate()
  return {
    destination,
    /** The destination owner's validated listing, so authority needs no second scan. */
    scanned: async (repo: Repo) => scans.get(ownerKey(repo)) ?? deps.scan(repo),
    /** Synchronous commit-time proof: still retired, still the one current destination. */
    admit: () => {
      if (nominate().workspaceId !== destination.workspaceId) {
        throw new StructuredWorkspaceUnavailable('obsolete')
      }
    }
  }
}
