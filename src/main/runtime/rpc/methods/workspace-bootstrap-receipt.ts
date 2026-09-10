import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  WORKSPACE_BOOTSTRAP_DIRTY_PATH_SAMPLE_LIMIT,
  WorkspaceBootstrapReceiptV2Schema,
  workspaceIdentity,
  type WorkspaceBootstrapReceiptV2,
  type WorkspaceBootstrapWorkspaceIdentity
} from '../../../../shared/workspace-bootstrap-receipt'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../../shared/execution-host'
import {
  WORKSPACE_BOOTSTRAP_GIT_HOME_RUNTIME_CAPABILITY,
  WORKSPACE_BOOTSTRAP_RECEIPT_V2_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcContext, type RpcMethod } from '../core'
import { resolveRunScope } from './orchestration/runs/run-scope'

export type WorkspaceBootstrapReceiptRequest = {
  runId: string
  /** Selector for the workspace that owns Orchestration state (Runs/Tasks/mailboxes) — always local. */
  orchestrationHomeSelector: string
  /** Selector for the workspace that actually executes this run's work; equals orchestrationHomeSelector for a purely local run. */
  executionWorkspaceSelector: string
  /**
   * The caller's expected execution host identity (e.g. `local`, `ssh:<id>`,
   * `runtime:<id>`) for executionWorkspaceSelector. Checked byte-for-byte
   * against what the host itself resolves before anything else runs — a
   * stale or wrong caller-supplied host must never reach a git-status probe,
   * let alone get baked into an issued receipt.
   */
  executionHostId: string
}

const workspaceBootstrapReceiptParams = z
  .object({
    runId: z.string().regex(/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/),
    orchestrationHomeSelector: z.string().min(1).max(4096),
    executionWorkspaceSelector: z.string().min(1).max(4096),
    executionHostId: z.string().min(1).max(4096)
  })
  .strict()

export type WorkspaceBootstrapCoordinator = {
  terminalHandle: string
  paneKey: string
}

export function requireWorkspaceBootstrapHomeCapability(
  context: RpcContext,
  workspaceKey: string
): void {
  if (
    parseWorkspaceKey(workspaceKey)?.type === 'worktree' &&
    context.clientCapabilities !== undefined &&
    !context.clientCapabilities.includes(WORKSPACE_BOOTSTRAP_GIT_HOME_RUNTIME_CAPABILITY)
  ) {
    throw new OrchestrationError(
      'update_required',
      'Git orchestration homes require workspace-bootstrap.git-home.v1; update the calling Orca client.'
    )
  }
}

export function requireWorkspaceBootstrapCoordinator(
  context: RpcContext,
  runId: string
): WorkspaceBootstrapCoordinator {
  const caller =
    context.legacyCoordinatorAuthority ??
    context.orchestrationCompatibilityCallerAuthority ??
    context.runtime.verifyOrchestrationCompatibilityCaller(
      context.orchestrationCompatibilityEvidence,
      { currentRuntimeLaunchSufficient: true }
    )
  if (!caller) {
    throw new OrchestrationError(
      'unauthorized',
      'Workspace bootstrap receipts require an authenticated coordinator.'
    )
  }
  const database = context.runtime.getOrchestrationDb()
  const run = database.getRun(runId)
  const lease = database.getMaestroTerminalLeaseByHandle(caller.terminalHandle)
  const handoffRequestId = lease?.requestId.startsWith('handoff:')
    ? lease.requestId.slice('handoff:'.length)
    : null
  const handoff = handoffRequestId ? database.getCoordinatorHandoff(handoffRequestId) : undefined
  if (
    run &&
    lease?.role === 'coordinator' &&
    lease.runId === run.id &&
    lease.coordinatorGeneration === run.consumer_generation &&
    lease.paneKey === caller.paneKey &&
    'processIncarnation' in caller &&
    lease.ptyIncarnation === caller.processIncarnation &&
    handoff?.successorLeaseId === lease.id &&
    handoff.claimedGeneration === run.consumer_generation &&
    ['spawned', 'capsule_delivery_acknowledged', 'coordinator_claimed'].includes(handoff.phase)
  ) {
    return caller
  }
  const currentRun = resolveRunScope(context.runtime, {
    runId,
    callerTerminalHandle: caller.terminalHandle,
    callerPaneKey: caller.paneKey,
    requireCurrentConsumer: true,
    legacyCoordinatorRunId: context.legacyCoordinatorRunId,
    callerEvidence: context.orchestrationCompatibilityEvidence
  })
  if (
    currentRun.coordinator_handle !== caller.terminalHandle ||
    currentRun.coordinator_pane_key !== caller.paneKey ||
    ('consumerGeneration' in caller && caller.consumerGeneration !== currentRun.consumer_generation)
  ) {
    throw new OrchestrationError('consumer_fenced', 'Coordinator authority is stale.')
  }
  return caller
}

export function requireCoordinatorWorkspace(
  runtime: OrcaRuntimeService,
  caller: WorkspaceBootstrapCoordinator,
  workspaceKey: string
): void {
  const terminal = runtime.getOrchestrationDispatchAuthority(caller.terminalHandle)
  const terminalWorkspaceKey = terminal
    ? parseWorkspaceKey(terminal.worktreeId)
      ? terminal.worktreeId
      : worktreeWorkspaceKey(terminal.worktreeId)
    : null
  if (!terminal || terminal.paneKey !== caller.paneKey || terminalWorkspaceKey !== workspaceKey) {
    throw new OrchestrationError(
      'unauthorized',
      'The authenticated coordinator is not bound to the orchestration-home workspace.'
    )
  }
}

type ResolvedWorkspaceTargetBase = {
  /** Pure repository id (git-worktree) or folder-workspace id — never the combined `repoId::path` worktree id. */
  repositoryId: string
  /** The exact public workspace_key the resolver already produces — never re-derived, reformatted, or matched by equality-guessing. */
  workspaceKey: string
  path: string
  executionHostId: string
}

type ResolvedWorkspaceTarget = ResolvedWorkspaceTargetBase &
  (
    | {
        kind: Extract<WorkspaceBootstrapWorkspaceIdentity['kind'], 'folder'>
        gitStatusSelector: null
      }
    | {
        kind: Extract<WorkspaceBootstrapWorkspaceIdentity['kind'], 'git-worktree'>
        gitStatusSelector: string
      }
  )

async function resolveWorkspaceTarget(
  runtime: OrcaRuntimeService,
  selector: string
): Promise<ResolvedWorkspaceTarget> {
  const worktree = await runtime.showManagedTerminalWorkspace(selector)
  const executionHostId = worktree.hostId ?? LOCAL_EXECUTION_HOST_ID
  // Why: a folder workspace's resolved id is already the exact `folder:<id>`
  // key (folderWorkspaceToWorktree stamps it that way) — parse it instead of
  // guessing via an id equality lookup against listFolderWorkspaces(), which
  // never matches a raw folder id against this already-prefixed id.
  const asWorkspaceKey = parseWorkspaceKey(worktree.id)
  if (asWorkspaceKey?.type === 'folder') {
    return {
      repositoryId: asWorkspaceKey.folderWorkspaceId,
      workspaceKey: worktree.id,
      kind: 'folder',
      path: worktree.path,
      executionHostId,
      gitStatusSelector: null
    }
  }
  return {
    repositoryId: worktree.repoId,
    workspaceKey: worktreeWorkspaceKey(worktree.id),
    kind: 'git-worktree',
    path: worktree.path,
    executionHostId,
    gitStatusSelector: `id:${worktree.id}`
  }
}

function workspaceIdentityFor(
  target: ResolvedWorkspaceTarget
): WorkspaceBootstrapWorkspaceIdentity {
  return workspaceIdentity({
    executionHostId: target.executionHostId,
    workspaceKey: target.workspaceKey,
    kind: target.kind,
    path: target.path,
    ...(target.kind === 'git-worktree' ? { worktreePath: target.path } : {})
  })
}

function isRemoteExecutionHost(executionHostId: string): boolean {
  return parseExecutionHostId(executionHostId)?.kind !== 'local'
}

/**
 * Host-authoritative issuance: every field is resolved from this runtime's
 * own repo/worktree/git state, never from a caller-supplied path or ID. A
 * validated run ID plus separate orchestration-home and execution-workspace
 * selectors resolve to one exact, versioned receipt. base_revision and
 * dirty_paths are read from the EXECUTION workspace's host — local or SSH —
 * through the same authoritative getRuntimeGitStatus every other Git RPC
 * uses; an unobservable remote host fails typed rather than fabricating a
 * snapshot from the (possibly distinct, always-local) orchestration home.
 */
export async function issueWorkspaceBootstrapReceipt(
  runtime: OrcaRuntimeService,
  request: WorkspaceBootstrapReceiptRequest
): Promise<WorkspaceBootstrapReceiptV2> {
  if (!request.runId || request.runId.trim().length === 0) {
    throw new OrchestrationError('invalid_argument', 'A validated run ID is required.')
  }

  const home = await resolveWorkspaceTarget(runtime, request.orchestrationHomeSelector)
  if (isRemoteExecutionHost(home.executionHostId)) {
    // Why: orchestration state (Runs/Tasks/mailboxes) is client-resident by
    // design (docs/reference/ssh-execution-boundary.md) — the orchestration
    // home can never itself be a remote SSH target.
    throw new OrchestrationError(
      'invalid_argument',
      'The orchestration-home workspace must be local; orchestration state is client-resident.'
    )
  }
  const executionTarget =
    request.executionWorkspaceSelector === request.orchestrationHomeSelector
      ? home
      : await resolveWorkspaceTarget(runtime, request.executionWorkspaceSelector)

  if (executionTarget.executionHostId !== request.executionHostId) {
    // Why: fail before any status probe — a caller whose expected host
    // doesn't match what the host itself resolves must never get a receipt
    // issued (or even trigger a git-status RPC) against the wrong target.
    throw new OrchestrationError(
      'invalid_argument',
      `Execution host mismatch: caller expected "${request.executionHostId}" but the execution workspace resolved to "${executionTarget.executionHostId}".`
    )
  }

  const revision =
    executionTarget.kind === 'folder'
      ? {
          base_revision_kind: 'folder_observation' as const,
          base_revision: `folder-observation:${randomUUID()}`,
          dirty_state: 'not_applicable' as const,
          dirty_path_count: 0,
          dirty_paths: [],
          dirty_paths_truncated: false
        }
      : await observeGitRevision(runtime, executionTarget.gitStatusSelector)

  return WorkspaceBootstrapReceiptV2Schema.parse({
    schema_version: 2,
    repository_id: home.repositoryId,
    canonical_root: home.path,
    execution_host: {
      id: executionTarget.executionHostId,
      boundary: isRemoteExecutionHost(executionTarget.executionHostId) ? 'remote' : 'local'
    },
    orchestration_home: workspaceIdentityFor(home),
    execution_workspace: workspaceIdentityFor(executionTarget),
    ...revision,
    authority: { kind: 'orca', scope: 'run', issued_for_run_id: request.runId }
  })
}

async function observeGitRevision(
  runtime: OrcaRuntimeService,
  selector: string
): Promise<
  Pick<
    WorkspaceBootstrapReceiptV2,
    | 'base_revision_kind'
    | 'base_revision'
    | 'dirty_state'
    | 'dirty_path_count'
    | 'dirty_paths'
    | 'dirty_paths_truncated'
  >
> {
  let status: Awaited<ReturnType<OrcaRuntimeService['getRuntimeGitStatus']>>
  try {
    status = await runtime.getRuntimeGitStatus(selector)
  } catch (error) {
    throw new OrchestrationError(
      'invalid_argument',
      `Could not observe Git status on the execution workspace's host: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  const baseRevision = status.head ?? '0'.repeat(40)
  const dirtyPathSet = new Set(status.entries.map((entry) => entry.path))
  const dirtyPathCount = dirtyPathSet.size
  const dirtyPaths = [...dirtyPathSet]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, WORKSPACE_BOOTSTRAP_DIRTY_PATH_SAMPLE_LIMIT)
  return {
    base_revision_kind: 'git_head',
    base_revision: baseRevision,
    dirty_state: dirtyPathCount === 0 ? 'clean' : 'dirty',
    dirty_path_count: dirtyPathCount,
    dirty_paths: dirtyPaths,
    dirty_paths_truncated: dirtyPathCount > dirtyPaths.length
  }
}

export const ORCHESTRATION_WORKSPACE_BOOTSTRAP_RECEIPT_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workspaceBootstrapReceipt',
    params: workspaceBootstrapReceiptParams,
    handler: async (request, context) => {
      if (
        context.clientCapabilities !== undefined &&
        !context.clientCapabilities.includes(WORKSPACE_BOOTSTRAP_RECEIPT_V2_RUNTIME_CAPABILITY)
      ) {
        throw new OrchestrationError(
          'update_required',
          'Workspace bootstrap receipt v2 is required; update the calling Orca client.'
        )
      }
      const caller = requireWorkspaceBootstrapCoordinator(context, request.runId)
      const receipt = await issueWorkspaceBootstrapReceipt(context.runtime, request)
      requireCoordinatorWorkspace(context.runtime, caller, receipt.orchestration_home.workspace_key)
      requireWorkspaceBootstrapHomeCapability(context, receipt.orchestration_home.workspace_key)
      return receipt
    }
  })
]
