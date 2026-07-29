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
import {
  selectTask,
  getTaskProjection,
  listTaskProjections
} from '../audited-workflow/audited-task-service'
import { broadcastAuditedTaskChanged } from '../audited-workflow/audited-workflow-broadcast'
import { RISK_LEVELS, TASK_SOURCES } from '../../shared/audited-workflow-types'
import type {
  AuditedWorkflowGetTaskParams,
  AuditedWorkflowListTasksParams,
  AuditedWorkflowSelectTaskParams,
  AuditedWorkflowSelectTaskResult,
  AuditedTaskStatusProjection
} from '../../shared/audited-workflow-types'

const ListTasksParams = z.object({ repoId: z.string().optional() })
const GetTaskParams = z.object({ taskId: z.string().min(1) })
const SelectTaskParams = z.object({
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
function isUnsupportedAuditedWorkflowHost(repo: {
  connectionId?: string | null
  kind?: 'git' | 'folder'
}): boolean {
  return Boolean(repo.connectionId) || isFolderRepo(repo)
}

export function registerAuditedWorkflowHandlers(store: Store): void {
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
}
