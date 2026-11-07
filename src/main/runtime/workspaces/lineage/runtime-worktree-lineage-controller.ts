import {
  isCrossStoreInferredSource,
  type CrossStoreInferredSource,
  type CrossStoreParentRef,
  type WorktreeLineage,
  type WorkspaceLineage
} from '../../../../shared/worktree/lineage-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'

import {
  type WorkspaceKey,
  folderWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../shared/workspace-scope'
import { sharesResolvedWorktreeLineageBoundary } from '../../../../shared/resolved-worktree-lineage'
import { crossStoreParentRefOfRow } from '../../../../shared/worktree/lineage-row-identity'
import type { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import type { RuntimeStore } from '../../runtime-store-contract'
import type { ResolvedWorktree } from '../catalog/runtime-worktree-path-identity'
import { readStoreInstallationId } from '../../hosts/platform-probe/host-descriptor'
import { assertParentInAnotherStore } from './cross-store-parent-store-check'
import { savedInstanceIdReader } from './saved-lineage-reads'
import { getCanonicalUserDataPath } from '../../../persistence/loading-store/user-data-path'
import {
  RuntimeLineageError,
  LINEAGE_PARENT_AMBIGUOUS,
  formatAmbiguousCwdParentMessage,
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
  showTerminal(handle: string): Promise<{ worktreeId: string }>
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
    if (resolution.kind === 'crossStore') {
      await assertParentInAnotherStore(resolution.parent, () => this.readStoreInstallationId())
    }
    const retained = enforceCreateLineageHostBoundary(resolution, childHostId)
    if (
      retained.kind === 'lineage' &&
      retained.capture.source === 'cwd-context' &&
      input?.cwdParentAmbiguous === true
    ) {
      throw new RuntimeLineageError(LINEAGE_PARENT_AMBIGUOUS, formatAmbiguousCwdParentMessage())
    }
    return retained
  }

  /** The parent a same-store create would infer from this caller context, as a ref for a child in
   * another store. `installationId` is the runtime's published identity, never created here. A
   * reason replaces the ref when none is valid or contexts conflict. */
  async resolveCallerParentForAnotherStore(
    input: Pick<
      WorktreeLineageInput,
      | 'envParentWorkspace'
      | 'callerTerminalHandle'
      | 'cwdParentWorktree'
      | 'cwdParentAmbiguous'
      | 'comment'
    >,
    installationId: string | undefined
  ): Promise<
    { parent: CrossStoreParentRef; source: CrossStoreInferredSource } | { reason: string }
  > {
    let resolution: WorktreeLineageResolution
    try {
      resolution = await this.resolveCreate(input)
    } catch (error) {
      return { reason: error instanceof Error ? error.message : String(error) }
    }
    if (resolution.kind !== 'lineage') {
      const conflict =
        resolution.kind === 'none' &&
        resolution.warnings.some((warning) => warning.code === 'LINEAGE_PARENT_CONTEXT_CONFLICT')
      return {
        reason: conflict
          ? "this terminal's contexts name different workspaces."
          : "Orca couldn't find this terminal's workspace."
      }
    }
    const { parent, capture } = resolution
    const ref = crossStoreParentRefOfRow(
      installationId,
      parent.type === 'folder' ? { id: parent.workspaceKey } : parent.worktree
    )
    if (!ref) {
      return { reason: "Orca couldn't confirm this workspace's identity." }
    }
    if (!isCrossStoreInferredSource(capture.source)) {
      return { reason: "Orca couldn't tell which workspace this command runs in." }
    }
    return { parent: ref, source: capture.source }
  }

  /** This store's identity; the published descriptor reads the same file at the canonical path. */
  async readStoreInstallationId(): Promise<string | undefined> {
    return await readStoreInstallationId(null, getCanonicalUserDataPath())
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
    // Reparent invalidates the resolved cache; saved metadata must cover intermediate nodes or longer loops escape detection.
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
      // An unrelated saved loop must not block this parent.
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
        // As for the caller's own terminal: a task made in a folder workspace names that folder.
        parent: await this.resolveParent(`id:${terminal.worktreeId}`),
        taskId
      }
    } catch {
      return null
    }
  }

  async listWorktreeLineage(): Promise<Record<string, WorktreeLineage>> {
    return this.deps.getStore()?.getAllWorktreeLineage?.() ?? {}
  }

  async listWorkspaceLineage(): Promise<Record<WorkspaceKey, WorkspaceLineage>> {
    return this.deps.getStore()?.getAllWorkspaceLineage?.() ?? {}
  }
}
