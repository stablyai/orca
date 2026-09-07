import type { FolderWorkspace, WorkspaceKey } from '../../shared/folder-workspace-types'
import type { WorktreeLineage, WorktreeLineageWarning } from '../../shared/worktree/lineage-types'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'

export type WorktreeLineageInput = NonNullable<RuntimeManagedWorktreeCreateArgs['lineage']>

export type ResolvedWorkspaceParent =
  | {
      type: 'worktree'
      workspaceKey: WorkspaceKey
      worktree: ResolvedWorktree
      instanceId: string | null
    }
  | {
      type: 'folder'
      workspaceKey: WorkspaceKey
      folderWorkspace: FolderWorkspace
      instanceId: string | null
    }

export type WorktreeLineageResolution =
  | {
      kind: 'lineage'
      parent: ResolvedWorkspaceParent
      origin: WorktreeLineage['origin']
      capture: WorktreeLineage['capture']
      orchestrationRunId?: string
      taskId?: string
      coordinatorHandle?: string
      createdByTerminalHandle?: string
    }
  | { kind: 'none'; warnings: WorktreeLineageWarning[] }

export type WorktreeLineageCandidate = {
  source: 'env-workspace' | 'cwd-context' | 'terminal-context' | 'orchestration-context'
  parent: ResolvedWorkspaceParent
  orchestrationRunId?: string
  taskId?: string
  coordinatorHandle?: string
}

export class RuntimeLineageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
  }
}

export class WorktreeIdRequiresFullPathError extends Error {
  readonly code = 'worktree_id_requires_full_path'

  constructor() {
    super(
      'Worktree id selectors must use the full <repo-id>::<path> value. Use the id from `orca worktree list --json`, or target by path:<path>, branch:<branch>, or issue:<number>.'
    )
  }
}

type LineageResolutionDependencies = {
  resolveParent(selector: string): Promise<ResolvedWorkspaceParent>
  resolveWorktreeParent(selector: string): Promise<ResolvedWorkspaceParent>
  resolveTaskCandidate(taskId: string): Promise<WorktreeLineageCandidate | null>
  resolveCaller(handle: string): Promise<{
    parent: ResolvedWorkspaceParent
    activeDispatch?: { taskId: string }
    activeRun?: { id: string; coordinatorHandle: string }
  }>
}

export async function resolveRuntimeWorktreeCreateLineage(
  input: WorktreeLineageInput | undefined,
  deps: LineageResolutionDependencies
): Promise<WorktreeLineageResolution> {
  const nextSteps = [
    'Pass a valid --parent-worktree selector such as folder:<id>, worktree:<worktreeId>, id:<repo-id>::<path>, branch:<branch>, issue:<number>, path:<absolute-path>, or active/current.',
    'Retry with --no-parent to create without lineage.'
  ]
  const notFoundMessage = (error: unknown): string =>
    error instanceof WorktreeIdRequiresFullPathError
      ? error.message
      : 'Parent selector was not found.'
  if (!input) {
    return { kind: 'none', warnings: [] }
  }
  if (
    (input.noParent === true && (input.parentWorkspace || input.parentWorktree)) ||
    (input.parentWorkspace && input.parentWorktree)
  ) {
    throw new RuntimeLineageError(
      'LINEAGE_PARENT_CONTEXT_CONFLICT',
      'Choose either one parent selector or --no-parent.'
    )
  }
  if (input.noParent === true) {
    return { kind: 'none', warnings: [] }
  }
  if (input.parentWorkspace) {
    try {
      const parent = await deps.resolveParent(input.parentWorkspace)
      const manuallySelected = input.parentWorkspaceOrigin === 'manual'
      return {
        kind: 'lineage',
        parent,
        origin: manuallySelected ? 'manual' : 'cli',
        capture: manuallySelected
          ? {
              source: parent.type === 'worktree' ? 'manual-action' : 'active-workspace',
              confidence: 'explicit'
            }
          : { source: 'explicit-cli-flag', confidence: 'explicit' }
      }
    } catch (error) {
      throw new RuntimeLineageError('LINEAGE_PARENT_NOT_FOUND', notFoundMessage(error), {
        nextSteps
      })
    }
  }
  if (input.parentWorktree) {
    try {
      return {
        kind: 'lineage',
        parent: await deps.resolveWorktreeParent(input.parentWorktree),
        origin: 'cli',
        capture: { source: 'explicit-cli-flag', confidence: 'explicit' }
      }
    } catch (error) {
      throw new RuntimeLineageError('LINEAGE_PARENT_NOT_FOUND', notFoundMessage(error), {
        nextSteps
      })
    }
  }
  const warnings: WorktreeLineageWarning[] = []
  const candidates: WorktreeLineageCandidate[] = []
  let cwdCandidate: WorktreeLineageCandidate | null = null
  let terminalContextResolved = false
  if (input.envParentWorkspace) {
    try {
      candidates.push({
        source: 'env-workspace',
        parent: await deps.resolveParent(input.envParentWorkspace)
      })
    } catch {
      warnings.push({
        code: 'LINEAGE_PARENT_CONTEXT_MISSING',
        message: 'Worktree created, but Orca could not validate the environment parent context.',
        details: { envParentWorkspace: input.envParentWorkspace }
      })
    }
  }
  if (input.orchestrationContext?.parentWorktreeId) {
    try {
      candidates.push({
        source: 'orchestration-context',
        parent: await deps.resolveWorktreeParent(
          `id:${input.orchestrationContext.parentWorktreeId}`
        )
      })
    } catch {}
  }
  const taskId = input.comment?.match(/\btask_[A-Za-z0-9]+\b/)?.[0]
  if (taskId) {
    const candidate = await deps.resolveTaskCandidate(taskId)
    if (candidate) {
      candidates.push(candidate)
    }
  }
  if (input.callerTerminalHandle) {
    try {
      const caller = await deps.resolveCaller(input.callerTerminalHandle)
      candidates.push(
        caller.activeDispatch
          ? {
              source: 'orchestration-context',
              parent: caller.parent,
              taskId: caller.activeDispatch.taskId,
              ...(caller.activeRun
                ? {
                    orchestrationRunId: caller.activeRun.id,
                    coordinatorHandle: caller.activeRun.coordinatorHandle
                  }
                : {})
            }
          : { source: 'terminal-context', parent: caller.parent }
      )
      terminalContextResolved = true
    } catch {
      warnings.push({
        code: 'LINEAGE_PARENT_CONTEXT_MISSING',
        message:
          'Worktree created, but Orca could not validate the caller terminal as a parent context.',
        details: { callerTerminalHandle: input.callerTerminalHandle }
      })
    }
  }
  if (input.cwdParentWorktree) {
    try {
      cwdCandidate = {
        source: 'cwd-context',
        parent: await deps.resolveParent(input.cwdParentWorktree)
      }
    } catch {
      warnings.push({
        code: 'LINEAGE_PARENT_CONTEXT_MISSING',
        message:
          'Worktree created, but Orca could not validate the current directory as a parent context.',
        details: { cwdParentWorktree: input.cwdParentWorktree }
      })
    }
  }
  if (candidates.length === 0 && cwdCandidate) {
    candidates.push(cwdCandidate)
  }
  if (candidates.length === 0) {
    return { kind: 'none', warnings }
  }
  const [first] = candidates
  if (candidates.some((candidate) => candidate.parent.workspaceKey !== first.parent.workspaceKey)) {
    return {
      kind: 'none',
      warnings: [
        {
          code: 'LINEAGE_PARENT_CONTEXT_CONFLICT',
          message: 'Worktree created, but Orca could not prove which parent context caused it.',
          details: {
            terminalParentWorkspaceKey: candidates.find((c) => c.source === 'terminal-context')
              ?.parent.workspaceKey,
            envParentWorkspaceKey: candidates.find((c) => c.source === 'env-workspace')?.parent
              .workspaceKey,
            orchestrationParentWorkspaceKey: candidates.find(
              (c) => c.source === 'orchestration-context'
            )?.parent.workspaceKey
          }
        }
      ]
    }
  }
  const preferred =
    candidates.find((candidate) => candidate.source === 'env-workspace') ??
    candidates.find((candidate) => candidate.source === 'orchestration-context') ??
    first
  return {
    kind: 'lineage',
    parent: preferred.parent,
    origin: preferred.source === 'orchestration-context' ? 'orchestration' : 'cli',
    capture: { source: preferred.source, confidence: 'inferred' },
    ...((preferred.orchestrationRunId ?? input.orchestrationContext?.orchestrationRunId)
      ? {
          orchestrationRunId:
            preferred.orchestrationRunId ?? input.orchestrationContext?.orchestrationRunId
        }
      : {}),
    ...((preferred.taskId ?? input.orchestrationContext?.taskId)
      ? { taskId: preferred.taskId ?? input.orchestrationContext?.taskId }
      : {}),
    ...((preferred.coordinatorHandle ?? input.orchestrationContext?.coordinatorHandle)
      ? {
          coordinatorHandle:
            preferred.coordinatorHandle ?? input.orchestrationContext?.coordinatorHandle
        }
      : {}),
    ...(terminalContextResolved && input.callerTerminalHandle
      ? { createdByTerminalHandle: input.callerTerminalHandle }
      : {})
  }
}
