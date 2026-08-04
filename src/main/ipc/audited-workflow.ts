// Electron IPC surface for Audited Workflow. Phase 1 only: task selection
// (read-only repo resolution, no worktree provisioning yet) and status
// projection. No RPC methods are registered anywhere for this feature —
// Audited Workflow is deliberately Electron-IPC-only, so it can never reach
// mobile/remote clients (see plan §10.2 and mobile-rpc-allowlist.test.ts).
import { ipcMain } from 'electron'
import { z } from 'zod'
import type { Store } from '../persistence'
import { getGitRepoRoot } from '../git/repo'
import { gitExecFileAsync } from '../git/runner'
import { isFolderRepo } from '../../shared/repo-kind'
import { parseWslPath } from '../wsl'
import {
  selectTask,
  getTaskProjection,
  listTaskProjections
} from '../audited-workflow/audited-task-service'
import { registerAuditedPlanReviewHandlers } from './audited-workflow-plan-review'
import { registerAuditedCodeAuditHandlers } from './audited-workflow-code-audit'
import { registerAuditedWorkflowCommitHandlers } from './audited-workflow-commit'
import { registerAuditedWorkflowPublishHandlers } from './audited-workflow-publish'
import { registerAuditedWorkflowLandHandlers } from './audited-workflow-land'
import { runAuditedWorkflowStartupRecovery } from './audited-workflow-startup-recovery'
import { registerAuditedCodexProviderHandlers } from './audited-workflow-codex-provider'
import { startTriage, retryTriage } from '../audited-workflow/audited-triage-orchestration'
import {
  hasAuditedTriageApiKey,
  saveAuditedTriageApiKey,
  clearAuditedTriageApiKey
} from '../audited-workflow/audited-triage-api-key-store'
import {
  ensureWorktreeForTask,
  rebuildAuditedWorktreeRegistry,
  recoverWorktreeForTask,
  setAuditedWorktreeStore
} from '../audited-workflow/audited-worktree-service'
import { registerAuditedExecutionHandlers } from './audited-workflow-execution'
import { broadcastAuditedTaskChanged } from '../audited-workflow/audited-workflow-broadcast'
import { RISK_LEVELS, TASK_SOURCES } from '../../shared/audited-workflow-types'
import type {
  AuditedWorkflowGetTaskParams,
  AuditedWorkflowListTasksParams,
  AuditedWorkflowSelectTaskParams,
  AuditedWorkflowSelectTaskResult,
  AuditedWorkflowStartTriageParams,
  AuditedWorkflowStartTriageResult,
  AuditedWorkflowRetryTriageParams,
  AuditedWorkflowRetryTriageResult,
  AuditedWorkflowProvisionWorktreeParams,
  AuditedWorkflowProvisionWorktreeResult,
  AuditedWorkflowVerifyWorktreeParams,
  AuditedWorkflowVerifyWorktreeResult,
  AuditedWorkflowTriageProviderStatus,
  AuditedWorkflowSaveTriageApiKeyParams,
  AuditedTaskStatusProjection
} from '../../shared/audited-workflow-types'

// Why .strict(): an extra path/branch/commit/provenance/worktreeId key must be
// REJECTED, not silently stripped — the renderer must never be able to influence
// worktree identity, and a stripped key would hide a caller bug.
const ListTasksParams = z.object({ repoId: z.string().optional() }).strict()
const GetTaskParams = z.object({ taskId: z.string().min(1) }).strict()
const StartTriageParams = z.object({ taskId: z.string().min(1) }).strict()
const RetryTriageParams = z.object({ taskId: z.string().min(1) }).strict()
const ProvisionWorktreeParams = z.object({ taskId: z.string().min(1) }).strict()
const VerifyWorktreeParams = z.object({ taskId: z.string().min(1) }).strict()
const SaveTriageApiKeyParams = z.object({ apiKey: z.string().min(1) }).strict()
const SelectTaskParams = z
  .object({
    repoId: z.string().min(1),
    source: z.enum(TASK_SOURCES),
    roadmapId: z.string().optional(),
    title: z
      .string()
      .trim()
      .min(1, 'Title is required')
      .max(200, 'Title is too long')
      .refine((v) => !/[\r\n]/.test(v), 'Title must be a single line'),
    description: z.string().max(20_000, 'Description is too long'),
    risk: z.enum(RISK_LEVELS)
  })
  .strict()

async function resolveHeadCommit(repoPath: string): Promise<string> {
  const { stdout } = await gitExecFileAsync(['rev-parse', 'HEAD'], { cwd: repoPath })
  return stdout.trim()
}

// Why: repo-kind and connection-target checks run BEFORE getGitRepoRoot /
// resolveHeadCommit are ever called, so a folder repo or an SSH-hosted repo
// never causes a Git command to be invoked at all (plan §17 non-goal:
// SSH/folder-hosted audited tasks are explicitly refused, not silently
// half-attempted). Both rejection kinds return the same closed
// 'unsupported_host' reason code — the renderer doesn't need to distinguish
// them, and neither reveals repo-specific detail.
// WSL is refused too: provisioning is native-local only, and a WSL-hosted repo
// would need a distro-scoped Git host the Phase 3 modules deliberately don't
// implement. All three rejections share the same closed code.
function isUnsupportedAuditedWorkflowHost(repo: {
  connectionId?: string | null
  kind?: 'git' | 'folder'
  path?: string
}): boolean {
  if (Boolean(repo.connectionId) || isFolderRepo(repo)) {
    return true
  }
  return typeof repo.path === 'string' && parseWslPath(repo.path) !== null
}

export function registerAuditedWorkflowHandlers(store: Store): void {
  setAuditedWorktreeStore(store)

  // ORDERING IS LOAD-BEARING: the guard registry must be warm before any
  // git-mutating channel exists. register-core-handlers.ts calls this function
  // (line ~182) before registerFilesystemHandlers / registerRuntimeHandlers
  // (~217/222), all synchronously in one invocation — so no mutation can be
  // dispatched against a live attempt's worktree after a restart.
  rebuildAuditedWorktreeRegistry()

  runAuditedWorkflowStartupRecovery()

  ipcMain.handle(
    'auditedWorkflow:listTasks',
    (_event, rawArgs: unknown): AuditedTaskStatusProjection[] => {
      const args: AuditedWorkflowListTasksParams = ListTasksParams.parse(rawArgs ?? {})
      return listTaskProjections(args.repoId)
    }
  )

  ipcMain.handle(
    'auditedWorkflow:getTask',
    (_event, rawArgs: unknown): AuditedTaskStatusProjection | null => {
      const args: AuditedWorkflowGetTaskParams = GetTaskParams.parse(rawArgs)
      return getTaskProjection(args.taskId)
    }
  )

  ipcMain.handle(
    'auditedWorkflow:selectTask',
    async (_event, rawArgs: unknown): Promise<AuditedWorkflowSelectTaskResult> => {
      // Why: Zod validation failures are a caller-programming-error class
      // distinct from expected runtime failures — they still throw, matching
      // every other handler in this module and the house IPC convention.
      // Everything past this point is an EXPECTED failure mode and returns a
      // structured { ok: false, reasonCode } instead of throwing, so no raw
      // exception message, path, or command text can reach the renderer.
      const args: AuditedWorkflowSelectTaskParams = SelectTaskParams.parse(rawArgs)

      const repo = store.getRepos().find((r) => r.id === args.repoId)
      if (!repo) {
        return { ok: false, reasonCode: 'repo_not_found' }
      }
      // Ordered BEFORE any Git command: an SSH-hosted or folder repo is
      // rejected here, so getGitRepoRoot/resolveHeadCommit are never called
      // for either kind (verified by src/main/ipc/audited-workflow.test.ts).
      if (isUnsupportedAuditedWorkflowHost(repo)) {
        return { ok: false, reasonCode: 'unsupported_host' }
      }

      let sourceRepoPath: string
      let baseCommit: string
      try {
        // Read-only resolution only — no worktree is provisioned in Phase 1.
        sourceRepoPath = getGitRepoRoot(repo.path)
        baseCommit = await resolveHeadCommit(sourceRepoPath)
      } catch (error) {
        // Why: the raw error (which may embed the repo's absolute path,
        // the git argv, or stderr) is logged locally for diagnostics and
        // NEVER forwarded to the renderer — see plan §10.2/§10.3.
        console.error('[auditedWorkflow] Git resolution failed during task selection:', error)
        return { ok: false, reasonCode: 'git_resolution_failed' }
      }

      let created: { taskId: string }
      try {
        created = selectTask({
          repoId: args.repoId,
          sourceRepoPath,
          baseCommit,
          hostId: 'local',
          title: args.title,
          spec: { title: args.title, description: args.description },
          source: args.source,
          roadmapEntryId: args.roadmapId ?? null,
          risk: args.risk
        })
      } catch (error) {
        console.error('[auditedWorkflow] Task creation failed:', error)
        return { ok: false, reasonCode: 'internal_error' }
      }

      const projection = getTaskProjection(created.taskId)
      if (projection) {
        broadcastAuditedTaskChanged(projection)
      }

      return { ok: true, taskId: created.taskId }
    }
  )

  ipcMain.handle(
    'auditedWorkflow:startTriage',
    async (_event, rawArgs: unknown): Promise<AuditedWorkflowStartTriageResult> => {
      const args: AuditedWorkflowStartTriageParams = StartTriageParams.parse(rawArgs)

      // Why: startTriage's own CAS-guarded write is the source of truth for
      // legality/contention; nothing thrown by the provider or the
      // orchestration layer should ever reach here as an uncaught exception
      // in normal operation, but a catch-all is kept so a genuinely
      // unexpected failure still returns a closed code instead of an
      // unhandled rejection or a raw error reaching the renderer.
      let result: AuditedWorkflowStartTriageResult
      try {
        result = await startTriage(args.taskId)
      } catch (error) {
        console.error('[auditedWorkflow] startTriage failed unexpectedly:', error)
        return { ok: false, kind: 'triage', reasonCode: 'provider_error' }
      }

      const projection = getTaskProjection(args.taskId)
      if (projection) {
        broadcastAuditedTaskChanged(projection)
      }

      return result
    }
  )

  ipcMain.handle(
    'auditedWorkflow:retryTriage',
    async (_event, rawArgs: unknown): Promise<AuditedWorkflowRetryTriageResult> => {
      const args: AuditedWorkflowRetryTriageParams = RetryTriageParams.parse(rawArgs)

      // Why: same rationale as startTriage's catch-all — retryTriage's own
      // CAS-guarded write is authoritative for legality/contention; this is
      // defense-in-depth for a genuinely unexpected failure, not the
      // mechanism relied on to avoid stranding a run (see
      // audited-triage-orchestration.ts's runProviderAndFinalize).
      let result: AuditedWorkflowRetryTriageResult
      try {
        result = await retryTriage(args.taskId)
      } catch (error) {
        console.error('[auditedWorkflow] retryTriage failed unexpectedly:', error)
        return { ok: false, kind: 'triage', reasonCode: 'provider_error' }
      }

      const projection = getTaskProjection(args.taskId)
      if (projection) {
        broadcastAuditedTaskChanged(projection)
      }

      return result
    }
  )

  // Explicit, user-initiated worktree recovery. Admissible only for a blocked
  // task in one of the two shapes in audited-worktree-recovery.ts. On success
  // the task returns to its pre-block state; the provider is NOT invoked — the
  // user must click Start Triage separately.
  ipcMain.handle(
    'auditedWorkflow:provisionWorktree',
    async (_event, rawArgs: unknown): Promise<AuditedWorkflowProvisionWorktreeResult> => {
      const args: AuditedWorkflowProvisionWorktreeParams = ProvisionWorktreeParams.parse(rawArgs)
      let result: Awaited<ReturnType<typeof recoverWorktreeForTask>>
      try {
        result = await recoverWorktreeForTask(args.taskId)
      } catch (error) {
        console.error('[auditedWorkflow] provisionWorktree failed unexpectedly:', error)
        return { ok: false, kind: 'worktree', reasonCode: 'git_worktree_add_failed' }
      }

      const projection = getTaskProjection(args.taskId)
      if (projection) {
        broadcastAuditedTaskChanged(projection)
      }

      if (result.ok) {
        return { ok: true }
      }
      if ('contended' in result) {
        return { ok: false, kind: 'contended' }
      }
      if ('notAdmissible' in result) {
        // Recovery is not legal for this task's block shape (e.g. ambiguous or
        // occupied evidence) — never coerced into a retry.
        return { ok: false, kind: 'worktree', reasonCode: 'provision_evidence_ambiguous' }
      }
      return { ok: false, kind: 'worktree', reasonCode: result.reasonCode }
    }
  )

  ipcMain.handle(
    'auditedWorkflow:verifyWorktree',
    async (_event, rawArgs: unknown): Promise<AuditedWorkflowVerifyWorktreeResult> => {
      const args: AuditedWorkflowVerifyWorktreeParams = VerifyWorktreeParams.parse(rawArgs)
      try {
        const result = await ensureWorktreeForTask(args.taskId)
        const projection = getTaskProjection(args.taskId)
        if (projection) {
          broadcastAuditedTaskChanged(projection)
        }
        if (result.ok) {
          return { ok: true }
        }
        if ('contended' in result) {
          return { ok: false, kind: 'contended' }
        }
        return { ok: false, kind: 'worktree', reasonCode: result.reasonCode }
      } catch (error) {
        console.error('[auditedWorkflow] verifyWorktree failed unexpectedly:', error)
        return { ok: false, kind: 'worktree', reasonCode: 'worktree_unreadable' }
      }
    }
  )

  registerAuditedExecutionHandlers()
  registerAuditedPlanReviewHandlers()
  registerAuditedCodeAuditHandlers()
  registerAuditedWorkflowCommitHandlers()
  registerAuditedWorkflowPublishHandlers()
  registerAuditedWorkflowLandHandlers()

  // Why: exposes ONLY whether a key is configured — never the key, a masked
  // form, encrypted bytes, or a filesystem path. See
  // audited-triage-api-key-store.ts and plan §10.2/§10.3 privacy boundaries.
  // This is Electron-IPC-only, like every other audited-workflow channel —
  // no RPC method is registered for it anywhere. Every handler below is
  // wrapped so a storage failure (unwritable ~/.orca, safeStorage decryption
  // failure, permission error, ...) can NEVER reject to the renderer with a
  // path, encryption detail, or raw exception message — it always resolves
  // to the same safe { configured } contract the success path returns.
  ipcMain.handle(
    'auditedWorkflow:getTriageProviderStatus',
    (): AuditedWorkflowTriageProviderStatus => {
      return { configured: safeHasAuditedTriageApiKey() }
    }
  )

  ipcMain.handle(
    'auditedWorkflow:saveTriageApiKey',
    (_event, rawArgs: unknown): AuditedWorkflowTriageProviderStatus => {
      const args: AuditedWorkflowSaveTriageApiKeyParams = SaveTriageApiKeyParams.parse(rawArgs)
      try {
        saveAuditedTriageApiKey(args.apiKey)
      } catch (error) {
        console.error('[auditedWorkflow] Saving the triage API key failed:', error)
      }
      return { configured: safeHasAuditedTriageApiKey() }
    }
  )

  ipcMain.handle('auditedWorkflow:clearTriageApiKey', (): AuditedWorkflowTriageProviderStatus => {
    try {
      clearAuditedTriageApiKey()
    } catch (error) {
      console.error('[auditedWorkflow] Clearing the triage API key failed:', error)
    }
    return { configured: safeHasAuditedTriageApiKey() }
  })

  registerAuditedCodexProviderHandlers()
}

// Why: hasAuditedTriageApiKey is a plain existsSync check today but is not
// contractually guaranteed never to throw (e.g. an EACCES on the .orca
// directory itself) — every call site above must be able to fall back to a
// safe, closed status rather than let any exception escape the handler.
function safeHasAuditedTriageApiKey(): boolean {
  try {
    return hasAuditedTriageApiKey()
  } catch (error) {
    console.error('[auditedWorkflow] Checking the triage API key status failed:', error)
    return false
  }
}
