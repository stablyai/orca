import { resolveLocalProjectRuntimesForRepos } from './local-project-runtime-resolution'
import { getCachedWslAvailability, getCachedWslDistros } from './wsl'
import { getLocalProjectWorktreeGitOptionsForRuntime } from './project-runtime-git-options'
import type { RuntimeStore } from './runtime/runtime-store-contract'
import type { ProjectExecutionRuntimeResolution } from '../shared/project-execution-runtime'
import type { WorktreeMeta } from '../shared/worktree/meta-types'
import type { Repo } from '../shared/repo-types'
import { getRepoExecutionHostId, type ExecutionHostId } from '../shared/execution-host'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  isWorktreeHostIdentity
} from '../shared/worktree/host-qualified-identity'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR, splitWorktreeId } from '../shared/worktree/id'
import { readAllWorktreeMetaForHost } from './persistence/host-qualified-worktree-meta'
import {
  addWorkspaceSessionWorktreeOwners,
  getPersistedWorktreeOwnerId
} from './persistence/restoring-sessions/session-worktree-ownership'

export type WorktreeInventoryStore = Pick<
  RuntimeStore,
  | 'getWorkspaceSession'
  | 'getAllWorktreeMeta'
  | 'getAllWorktreeMetaForHost'
  | 'onWorkspaceSessionWritten'
  | 'onStateWritten'
> &
  Partial<Pick<RuntimeStore, 'getRepos' | 'getProjects' | 'getSettings'>>
export type KnownWorktreePath = { path: string; hasSession: boolean; instanceId?: string }
export type RepoWorktreeInventory = {
  paths: KnownWorktreePath[]
  meta: Record<string, WorktreeMeta>
}
const EMPTY_INVENTORY: RepoWorktreeInventory = { paths: [], meta: {} }

/** Store-owned notifications, rather than mutable getter identity, define the derived census lifetime. */
class HostWorktreeInventory {
  private readonly hosts = new Map<ExecutionHostId, Map<string, RepoWorktreeInventory>>()
  private readonly dirty = new Set<ExecutionHostId>()
  private routesDirty = true
  private discovery = ''
  private routes = new Map<string, string>()
  private runtimes: ReadonlyMap<string, ProjectExecutionRuntimeResolution> = new Map()
  readonly reusable: boolean

  constructor(private readonly store: WorktreeInventoryStore) {
    this.reusable = !!store.onStateWritten && !!store.onWorkspaceSessionWritten
    store.onWorkspaceSessionWritten?.((host) => {
      if (host) {
        this.dirty.add(host)
      } else {
        for (const key of this.hosts.keys()) {
          this.dirty.add(key)
        }
      }
    })
    store.onStateWritten?.((domains) => {
      if (
        !domains ||
        domains.some((domain) =>
          ['settings', 'projects', 'repos', 'projectHostSetups'].includes(domain)
        )
      ) {
        this.routesDirty = true
      }
      if (!domains || domains.some((domain) => domain.startsWith('worktree'))) {
        for (const key of this.hosts.keys()) {
          this.dirty.add(key)
        }
      }
    })
  }

  route(repo: Repo): string {
    const discovery = JSON.stringify([getCachedWslAvailability(), getCachedWslDistros()])
    if (!this.reusable || this.routesDirty || discovery !== this.discovery) {
      this.discovery = discovery
      const repos = this.store.getRepos?.() ?? [repo]
      this.runtimes = resolveLocalProjectRuntimesForRepos(this.store, repos)
      this.routes = new Map(
        repos.map((row) => [
          this.key(row),
          JSON.stringify({
            path: row.path,
            runtime: this.runtimes.get(row.id)
          })
        ])
      )
      this.routesDirty = false
    }
    return this.routes.get(this.key(repo)) ?? 'unregistered'
  }

  gitOptions(repo: Repo) {
    this.route(repo)
    return getLocalProjectWorktreeGitOptionsForRuntime(repo, this.runtimes.get(repo.id))
  }

  private key(repo: Repo): string {
    return `${getRepoExecutionHostId(repo)}\0${repo.id}`
  }

  read(repo: Repo): RepoWorktreeInventory {
    const host = getRepoExecutionHostId(repo)
    const previous = this.hosts.get(host)
    if (!this.reusable || !previous || this.dirty.has(host)) {
      const grouped = new Map<string, Map<string, KnownWorktreePath>>()
      const add = (
        owner: string | null | undefined,
        hasSession: boolean,
        instanceId?: string
      ): void => {
        if (
          owner &&
          isWorktreeHostIdentity(owner) &&
          getExecutionHostIdFromWorktreeHostIdentity(owner) !== host
        ) {
          return
        }
        const id = getPersistedWorktreeOwnerId(owner)
        const parsed = id ? splitWorktreeId(id) : null
        if (!parsed || parsed.worktreePath.includes(FOLDER_WORKSPACE_INSTANCE_SEPARATOR)) {
          return
        }
        let paths = grouped.get(parsed.repoId)
        if (!paths) {
          grouped.set(parsed.repoId, (paths = new Map()))
        }
        const path = parsed.worktreePath
        paths.set(path, {
          path,
          hasSession: hasSession || paths.get(path)?.hasSession === true,
          instanceId: instanceId ?? paths.get(path)?.instanceId
        })
      }
      const session = this.store.getWorkspaceSession?.(host)
      if (session) {
        addWorkspaceSessionWorktreeOwners(session, {
          owners: new Set(),
          addOwner: (id) => add(id, true)
        })
      }
      const metaByRepo = new Map<string, Record<string, WorktreeMeta>>()
      for (const [id, meta] of Object.entries(readAllWorktreeMetaForHost(this.store, host))) {
        add(id, false, meta.instanceId)
        const parsed = splitWorktreeId(id)
        if (!parsed) {
          continue
        }
        let rows = metaByRepo.get(parsed.repoId)
        if (!rows) {
          metaByRepo.set(parsed.repoId, (rows = {}))
        }
        rows[id] = meta
      }
      const current = new Map<string, RepoWorktreeInventory>()
      for (const [id, paths] of grouped) {
        const next = [...paths.values()].sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0
        )
        const old = previous?.get(id)
        if (old) {
          old.meta = metaByRepo.get(id) ?? {}
        }
        current.set(
          id,
          old &&
            old.paths.length === next.length &&
            old.paths.every(
              (path, index) =>
                path.path === next[index].path &&
                path.hasSession === next[index].hasSession &&
                path.instanceId === next[index].instanceId
            )
            ? old
            : { paths: next, meta: metaByRepo.get(id) ?? {} }
        )
      }
      this.hosts.set(host, current)
      this.dirty.delete(host)
    }
    return this.hosts.get(host)?.get(repo.id) ?? EMPTY_INVENTORY
  }
}
const inventories = new WeakMap<WorktreeInventoryStore, HostWorktreeInventory>()
export function knownWorktreeInventory(store: WorktreeInventoryStore): HostWorktreeInventory {
  let inventory = inventories.get(store)
  if (!inventory) {
    inventories.set(store, (inventory = new HostWorktreeInventory(store)))
  }
  return inventory
}
