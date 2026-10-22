import type { WorktreeLineage, WorkspaceLineage } from '../../shared/worktree/lineage-types'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import type { WorkspaceKey } from '../../shared/folder-workspace-types'
import {
  folderWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../shared/workspace-scope'
import { sharesResolvedWorktreeLineageBoundary } from '../../shared/resolved-worktree-lineage'
import type { OrchestrationDb } from './orchestration/db'
import type { RuntimeStore } from './runtime-store-contract'
import {
  readAllWorktreeMetaForHost,
  worktreeRowTarget
} from '../persistence/host-qualified-worktree-meta'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { getRepoOwnedWorktreeMeta } from '../worktree-metadata-ownership'
import { isWslMoveWorktreeBlocked } from '../persistence/moving-wsl-projects/wsl-move-background-backoff'
import {
  RuntimeLineageError,
  enforceCreateLineageHostBoundary,
  resolveRuntimeWorktreeCreateLineage,
  type ResolvedWorkspaceParent,
  type WorktreeLineageCandidate,
  type WorktreeLineageInput,
  type WorktreeLineageResolution
} from './runtime-worktree-lineage-resolution'

type RuntimeWorktreeLineageDependencies = {
  getStore(): RuntimeStore | null
  getDb(): OrchestrationDb | null
  resolveWorktree(selector: string): Promise<ResolvedWorktree>
  listResolvedWorktrees(): Promise<ResolvedWorktree[]>
  showTerminal(handle: string): Promise<{ worktreeId: string }>
}

/**
 * Read-only and ownership-scoped like the resolved list: the migrating per-host accessor would adopt
 * another host's legacy row into this host just to answer a validation.
 */
function savedInstanceIdReader(
  store: RuntimeStore,
  hostId: ExecutionHostId | undefined
): (id: string) => string | undefined {
  if (!hostId) {
    return (id) => store.getWorktreeMeta(id)?.instanceId
  }
  const repos = store.getRepos()
  const ownerCounts = new Map<string, number>()
  for (const repo of repos) {
    ownerCounts.set(repo.id, (ownerCounts.get(repo.id) ?? 0) + 1)
  }
  const reposOnHost = new Map(
    repos.filter((repo) => getRepoExecutionHostId(repo) === hostId).map((repo) => [repo.id, repo])
  )
  const metaById = readAllWorktreeMetaForHost(store, hostId)
  return (id) => {
    const repo = reposOnHost.get(getRepoIdFromWorktreeId(id))
    return repo
      ? getRepoOwnedWorktreeMeta(repo, id, metaById, ownerCounts.get(repo.id) ?? 0)?.instanceId
      : undefined
  }
}

export class RuntimeWorktreeLineageController {
  constructor(private readonly deps: RuntimeWorktreeLineageDependencies) {}

  async resolveCreate(
    input?: WorktreeLineageInput,
    childHostId?: ExecutionHostId
  ): Promise<WorktreeLineageResolution> {
    const resolution = await resolveRuntimeWorktreeCreateLineage(input, {
      resolveParent: (selector) => this.resolveParent(selector),
      resolveWorktreeParent: (selector) => this.resolveWorktreeParent(selector),
      resolveTaskCandidate: (taskId) => this.resolveTaskCandidate(taskId),
      resolveCaller: async (handle) => {
        const terminal = await this.deps.showTerminal(handle)
        const parent = await this.resolveParent(`id:${terminal.worktreeId}`)
        const db = this.deps.getDb()
        const dispatch = db?.getActiveDispatchForTerminal(handle)
        const run = db?.getActiveCoordinatorRun()
        return {
          parent,
          ...(dispatch ? { activeDispatch: { taskId: dispatch.task_id } } : {}),
          ...(run ? { activeRun: { id: run.id, coordinatorHandle: run.coordinator_handle } } : {})
        }
      }
    })
    return enforceCreateLineageHostBoundary(resolution, childHostId)
  }

  async resolveParent(selector: string): Promise<ResolvedWorkspaceParent> {
    const rawSelector = selector.startsWith('id:') ? selector.slice(3) : selector
    const parsed = parseWorkspaceKey(rawSelector)
    if (parsed?.type === 'folder') {
      const folderWorkspace = this.deps
        .getStore()
        ?.getFolderWorkspaces?.()
        .find((workspace) => workspace.id === parsed.folderWorkspaceId)
      if (!folderWorkspace) {
        throw new Error('selector_not_found')
      }
      return {
        type: 'folder',
        workspaceKey: folderWorkspaceKey(folderWorkspace.id),
        folderWorkspace,
        instanceId: null
      }
    }
    return this.resolveWorktreeParent(
      parsed?.type === 'worktree' ? `id:${parsed.worktreeId}` : selector
    )
  }

  async resolveWorktreeParent(selector: string): Promise<ResolvedWorkspaceParent> {
    const worktree = await this.deps.resolveWorktree(selector)
    return {
      type: 'worktree',
      workspaceKey: worktreeWorkspaceKey(worktree.id),
      worktree,
      instanceId: worktree.instanceId ?? null
    }
  }

  validateParent(child: ResolvedWorktree, parent: ResolvedWorktree): void {
    if (child.id === parent.id) {
      throw new RuntimeLineageError('LINEAGE_PARENT_CYCLE', 'A worktree cannot parent itself.')
    }
    if (!sharesResolvedWorktreeLineageBoundary(child, parent)) {
      throw new RuntimeLineageError(
        'LINEAGE_PARENT_CONTEXT_CONFLICT',
        'Parent worktree must be on the same execution host.'
      )
    }
    const store = this.deps.getStore()
    let readSavedInstanceId: ((id: string) => string | undefined) | undefined
    // Why: saved metadata, not the resolved-worktree cache, which the reparent itself invalidates;
    // an unknown node would end the walk and let a longer loop through.
    const instanceIdOf = (id: string): string | undefined => {
      if (id === child.id || id === parent.id) {
        return id === child.id ? child.instanceId : parent.instanceId
      }
      readSavedInstanceId ??= store
        ? savedInstanceIdReader(store, child.hostId ?? parent.hostId)
        : () => undefined
      return readSavedInstanceId(id)
    }
    let cursor: string | undefined = parent.id
    const visited = new Set<string>()
    while (cursor) {
      if (cursor === child.id) {
        throw new RuntimeLineageError(
          'LINEAGE_PARENT_CYCLE',
          'Parent selector would create a lineage cycle.'
        )
      }
      // Why: a loop saved before this walk read saved data must not block unrelated parents.
      if (visited.has(cursor)) {
        break
      }
      visited.add(cursor)
      const lineage = store?.getWorktreeLineage?.(cursor)
      if (!lineage) {
        break
      }
      if (
        instanceIdOf(cursor) !== lineage.worktreeInstanceId ||
        instanceIdOf(lineage.parentWorktreeId) !== lineage.parentWorktreeInstanceId
      ) {
        break
      }
      cursor = lineage.parentWorktreeId
    }
  }

  async resolveTaskCandidate(taskId: string): Promise<WorktreeLineageCandidate | null> {
    const db = this.deps.getDb()
    const dispatch = db?.getDispatchContext(taskId)
    const handle = dispatch?.assignee_handle ?? db?.getTask(taskId)?.created_by_terminal_handle
    if (!handle) {
      return null
    }
    try {
      const terminal = await this.deps.showTerminal(handle)
      return {
        source: 'orchestration-context',
        parent: await this.resolveWorktreeParent(`id:${terminal.worktreeId}`),
        taskId
      }
    } catch {
      return null
    }
  }

  async hydrate(): Promise<void> {
    const store = this.deps.getStore()
    if (!store?.getWorktreeLineage || !store.setWorktreeLineage) {
      return
    }
    for (const worktree of await this.deps.listResolvedWorktrees()) {
      if (
        store.getWorktreeLineage(worktree.id) ||
        !worktree.instanceId ||
        isWslMoveWorktreeBlocked(worktree.id, worktree.hostId, worktree.path)
      ) {
        continue
      }
      const taskId = worktree.comment?.match(/\btask_[A-Za-z0-9]+\b/)?.[0]
      if (!taskId) {
        continue
      }
      const candidate = await this.resolveTaskCandidate(taskId)
      if (
        !candidate?.parent.instanceId ||
        candidate.parent.type !== 'worktree' ||
        candidate.parent.worktree.id === worktree.id
      ) {
        continue
      }
      try {
        this.validateParent(worktree, candidate.parent.worktree)
      } catch {
        continue
      }
      const target = worktreeRowTarget(store, worktree)
      if (!target) {
        continue
      }
      store.setWorktreeLineage(target, {
        worktreeId: worktree.id,
        worktreeInstanceId: worktree.instanceId,
        parentWorktreeId: candidate.parent.worktree.id,
        parentWorktreeInstanceId: candidate.parent.instanceId,
        origin: 'orchestration',
        capture: { source: 'orchestration-context', confidence: 'inferred' },
        taskId,
        createdAt: Date.now()
      })
    }
  }

  async listWorktreeLineage(): Promise<Record<string, WorktreeLineage>> {
    await this.hydrate()
    return this.deps.getStore()?.getAllWorktreeLineage?.() ?? {}
  }

  async listWorkspaceLineage(): Promise<Record<WorkspaceKey, WorkspaceLineage>> {
    await this.hydrate()
    return this.deps.getStore()?.getAllWorkspaceLineage?.() ?? {}
  }
}
