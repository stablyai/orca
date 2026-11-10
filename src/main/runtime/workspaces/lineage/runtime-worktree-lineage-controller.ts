import {
  confirmedWorktreeLineageProject,
  getWorkspaceLineagePolicy,
  PROJECT_LINEAGE_CONFLICT_MESSAGE
} from '../../../../shared/workspace-lineage-policy'
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
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { ResolvedWorktree } from '../catalog/runtime-worktree-path-identity'
import type {
  WorkspaceSelectorCandidate,
  WorkspaceSelectorOptions
} from '../catalog/workspace-selector-candidates'
import { readStoreInstallationId } from '../../hosts/platform-probe/host-descriptor'
import { assertParentInAnotherStore } from './cross-store-parent-store-check'
import { validateSavedLineageParentCycle } from './saved-lineage-reads'
import { getCanonicalUserDataPath } from '../../../persistence/loading-store/user-data-path'
import { RuntimeLineageError, LINEAGE_PARENT_AMBIGUOUS } from './runtime-lineage-error'
import {
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
  resolveWorkspace(
    selector: string,
    options?: WorkspaceSelectorOptions
  ): Promise<WorkspaceSelectorCandidate>
  showTerminal(handle: string): Promise<{ worktreeId: string }>
}

function worktreeParent(worktree: ResolvedWorktree): ResolvedWorkspaceParent {
  return {
    type: 'worktree',
    workspaceKey: worktreeWorkspaceKey(worktree.id),
    worktree,
    instanceId: worktree.instanceId ?? null
  }
}

export class RuntimeWorktreeLineageController {
  constructor(private readonly deps: RuntimeWorktreeLineageDependencies) {}

  async resolveCreate(
    input?: WorktreeLineageInput,
    childHostId?: ExecutionHostId,
    childProjectId?: string
  ): Promise<WorktreeLineageResolution> {
    const resolution = await resolveRuntimeWorktreeCreateLineage(input, {
      resolveParent: (selector) => this.resolveParent(selector),
      // An opted-in explicit parent is classified by its real kind; older requests stay repo-only.
      resolveWorktreeParent: (selector) =>
        input?.matchFolderWorkspaces
          ? this.resolveParent(selector, { matchFolders: true })
          : this.resolveWorktreeParent(selector),
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
    const retained = enforceCreateLineageHostBoundary(resolution, childHostId)
    if (
      retained.kind === 'lineage' &&
      retained.capture.source === 'cwd-context' &&
      input?.cwdParentAmbiguous === true
    ) {
      throw new RuntimeLineageError(LINEAGE_PARENT_AMBIGUOUS, formatAmbiguousCwdParentMessage())
    }
    const store = this.deps.getStore()
    const restricted =
      childHostId && getWorkspaceLineagePolicy(store?.getSettings?.()) === 'same-project'
    if (restricted && retained.kind !== 'none') {
      const parentProjectId =
        retained.kind === 'lineage' && retained.parent.type === 'worktree'
          ? confirmedWorktreeLineageProject(
              {
                projects: store?.getProjects?.() ?? [],
                projectHostSetups: store?.getProjectHostSetups?.() ?? []
              },
              retained.parent.worktree
            )
          : undefined
      if (!childProjectId || !parentProjectId || childProjectId !== parentProjectId) {
        const { parent, ...provenance } = retained
        if (retained.capture.confidence === 'explicit') {
          throw new RuntimeLineageError(
            'LINEAGE_PARENT_CONTEXT_CONFLICT',
            PROJECT_LINEAGE_CONFLICT_MESSAGE
          )
        }
        return {
          kind: 'none',
          warnings: [
            {
              code: 'LINEAGE_PARENT_CONTEXT_CONFLICT',
              message: `Workspace created as a root. ${PROJECT_LINEAGE_CONFLICT_MESSAGE}`,
              details: {
                ...input?.orchestrationContext,
                createdByTerminalHandle: input?.callerTerminalHandle,
                ...provenance,
                parentWorkspaceKey: parent.workspaceKey,
                ...(retained.kind === 'crossStore'
                  ? { parentInstallationId: retained.parent.installationId }
                  : {})
              }
            }
          ]
        }
      }
    }
    if (retained.kind === 'crossStore') {
      await assertParentInAnotherStore(retained.parent, () => this.readStoreInstallationId())
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

  /** A folder parent needs a unique id, not the child's host; a worktree parent's host is checked later. */
  async resolveParent(
    selector: string,
    options: { matchFolders?: boolean } = {}
  ): Promise<ResolvedWorkspaceParent> {
    const rawSelector = selector.startsWith('id:') ? selector.slice(3) : selector
    const parsed = parseWorkspaceKey(rawSelector)
    const candidate = await this.deps.resolveWorkspace(
      parsed?.type === 'worktree' ? `id:${parsed.worktreeId}` : selector,
      {
        matchFolders: options.matchFolders,
        anyFolderHost: true,
        readOnlyAdmission:
          getWorkspaceLineagePolicy(this.deps.getStore()?.getSettings?.()) === 'same-project'
      }
    )
    return candidate.kind === 'worktree'
      ? worktreeParent(candidate.worktree)
      : {
          type: 'folder',
          workspaceKey: folderWorkspaceKey(candidate.folder.id),
          folderWorkspace: candidate.folder,
          instanceId: null
        }
  }

  /** Repo-backed only, as older requests meant. */
  async resolveWorktreeParent(selector: string): Promise<ResolvedWorkspaceParent> {
    const candidate = await this.deps.resolveWorkspace(selector, {
      readOnlyAdmission:
        getWorkspaceLineagePolicy(this.deps.getStore()?.getSettings?.()) === 'same-project'
    })
    if (candidate.kind !== 'worktree') {
      throw new Error('selector_not_found')
    }
    return worktreeParent(candidate.worktree)
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
    if (getWorkspaceLineagePolicy(store?.getSettings?.()) === 'same-project') {
      const catalog = {
        projects: store?.getProjects?.() ?? [],
        projectHostSetups: store?.getProjectHostSetups?.() ?? []
      }
      const childProject = confirmedWorktreeLineageProject(catalog, child)
      if (!childProject || childProject !== confirmedWorktreeLineageProject(catalog, parent)) {
        throw new RuntimeLineageError(
          'LINEAGE_PARENT_CONTEXT_CONFLICT',
          PROJECT_LINEAGE_CONFLICT_MESSAGE
        )
      }
      if (store?.validatePersistedLineageParent && child.hostId) {
        store.validatePersistedLineageParent(
          {
            childWorkspaceKey: worktreeWorkspaceKey(child.id),
            childInstanceId: child.instanceId,
            parentWorkspaceKey: worktreeWorkspaceKey(parent.id),
            parentInstanceId: parent.instanceId,
            origin: 'manual',
            capture: { source: 'manual-action', confidence: 'explicit' },
            createdAt: Date.now()
          },
          child.hostId
        )
        return
      }
    }
    validateSavedLineageParentCycle(store, child, parent)
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
