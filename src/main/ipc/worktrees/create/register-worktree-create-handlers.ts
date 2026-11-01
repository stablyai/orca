import { ipcMain, app } from 'electron'
import { getLocalWorktreeCatalogVersion } from '../../../local-worktree-scan-generation'
import type {
  CreateWorktreeArgs,
  CreateWorktreeResult,
  AdoptProvisionedRootArgs
} from '../../../../shared/worktree/create-types'
import {
  addWorktreeCreatePhaseAttributes,
  withWorktreeSpan
} from '../../../observability/instrumentation'
import { workspaceSourceSchema } from '../../../../shared/telemetry-events'
import type { WorkspaceSource } from '../../../../shared/telemetry-events'
import {
  resolveAutomationWorkspaceProvenance,
  releaseAutomationWorkspaceProvenanceRequest,
  finishAutomationWorkspaceProvenanceRequest
} from '../../../automations/workspace-provenance'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { createLocalWorktree, notifyWorktreesChanged } from '../../worktree-remote'
import { SshHostNotServedError } from '../../../providers/ssh-host-not-served-error'
import { track } from '../../../telemetry/client'
import { classifyWorkspaceCreateError } from '../../workspace-create-error-classifier'
import { getCohortAtEmit } from '../../../telemetry/cohort-classifier'
import { adoptProvisionedRootSshCheckout } from '../../../provisioned-root-ssh-adoption'
import { normalizeLinkedWorkItemFields } from '../ipc-context-schemas'
import type { CreateWorktreeArgsWithSystemProvenance } from '../ipc-context-schemas'
import { createFolderWorkspace } from './folder-workspace-creation'
import { findExactRepoOwner, isCapturedRepoCurrent } from '../listing/worktree-host-ownership'
import { requireWorktreeCreateRoute } from '../../../worktree-create-execution-host-route'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { workspaceLifecycleKey } from '../../../runtime/workspaces/workspace-lifecycle-commands'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import { beginWorkspaceCreateTelemetry } from '../../../workspace-create-telemetry'
import { assertWslMoveRepoWritable } from '../../../persistence/moving-wsl-projects/wsl-move-scope-guard'

export function registerWorktreeCreateHandlers(context: WorktreeIpcContext): void {
  const { mainWindow, store, runtime, options } = context

  ipcMain.handle(
    'worktrees:create',
    async (_event, rawArgs: CreateWorktreeArgs): Promise<CreateWorktreeResult> => {
      const args = normalizeLinkedWorkItemFields(rawArgs)
      // Parent Git spans without recording user branch names or remote URLs.
      return withWorktreeSpan({ stage: 'create' }, async (span) => {
        const repo = store.getRepo(args.repoId)
        if (!repo) {
          throw new Error(`Repo not found: ${args.repoId}`)
        }
        assertWslMoveRepoWritable(store, repo)

        const automationProvenance = resolveAutomationWorkspaceProvenance({
          authority: runtime,
          repoSelector: args.repoId,
          repo,
          request: args.automationProvenanceRequest
        })
        const createArgs: CreateWorktreeArgsWithSystemProvenance = {
          ...args,
          automationProvenance
        }

        let result: CreateWorktreeResult
        // Keep failure telemetry in the handler so rejected creates retain their stage.
        const telemetry = beginWorkspaceCreateTelemetry({
          source: args.telemetrySource,
          entryPoint: 'app',
          repoPath: repo.path,
          fromExistingBranch: typeof args.baseBranch === 'string' && args.baseBranch.length > 0,
          isFolder: isFolderRepo(repo)
        })
        const creation = runtime.workspaceLifecycle?.openCreate({
          creationId: args.creationId,
          repoId: repo.id,
          keyOf: (worktreeId) => workspaceLifecycleKey(getRepoExecutionHostId(repo), worktreeId)
        })
        try {
          // Track operational failures; malformed IPC rejected above is outside the creation funnel.
          if (isFolderRepo(repo)) {
            // Folder creation only registers metadata, so it needs no filesystem host route.
            result = createFolderWorkspace(createArgs, repo, store)
          } else {
            // Resolve executionHostId-only SSH ownership before any local Git operation.
            const createRoute = requireWorktreeCreateRoute(repo)
            if (createRoute.kind === 'ssh') {
              // Record ownership before refusal so failure telemetry retains its host.
              telemetry.timing.recordExecutionHost('ssh')
              throw new SshHostNotServedError(createRoute.connectionId)
            }
            result = await createLocalWorktree(
              createArgs,
              repo,
              store,
              mainWindow,
              runtime,
              telemetry.timing,
              creation?.named
            )
          }
        } catch (error) {
          releaseAutomationWorkspaceProvenanceRequest(args.automationProvenanceRequest)
          telemetry.failed(error)
          throw error
        } finally {
          creation?.close()
        }
        finishAutomationWorkspaceProvenanceRequest(args.automationProvenanceRequest)
        if (result.timing) {
          addWorktreeCreatePhaseAttributes(span, result.timing)
        }

        telemetry.succeeded(result.timing)

        if (isFolderRepo(repo)) {
          notifyWorktreesChanged(mainWindow, repo.id)
        }

        options?.onWorktreeLifecycle?.({
          kind: 'created',
          worktreeId: result.worktree.id,
          path: result.worktree.path,
          branch: result.worktree.branch
        })

        // Stamp after the create notification bumps generation so the reply names its resulting catalog.
        return { ...result, catalogVersion: getLocalWorktreeCatalogVersion(repo.id) }
      })
    }
  )

  ipcMain.handle(
    'worktrees:adoptProvisionedRoot',
    async (_event, rawArgs: AdoptProvisionedRootArgs): Promise<CreateWorktreeResult> => {
      const args = normalizeLinkedWorkItemFields(rawArgs)
      return withWorktreeSpan({ stage: 'create' }, async () => {
        const repo = findExactRepoOwner(store, args.repoId, args.executionHostId)
        if (!repo || isFolderRepo(repo)) {
          throw new Error('Provisioned-root repository ownership is missing or ambiguous.')
        }
        assertWslMoveRepoWritable(store, repo)
        const sourceParse = workspaceSourceSchema.safeParse(args.telemetrySource)
        const source: WorkspaceSource = sourceParse.success ? sourceParse.data : 'unknown'
        const automationProvenance = resolveAutomationWorkspaceProvenance({
          authority: runtime,
          repoSelector: args.repoId,
          repo,
          request: args.automationProvenanceRequest
        })
        let result: CreateWorktreeResult
        try {
          result = await adoptProvisionedRootSshCheckout({
            userDataPath: app.getPath('userData'),
            request: { ...args, automationProvenance },
            repo,
            store,
            isRepoCurrent: () => isCapturedRepoCurrent(store, repo, args.executionHostId)
          })
        } catch (error) {
          releaseAutomationWorkspaceProvenanceRequest(args.automationProvenanceRequest)
          track('workspace_create_failed', {
            source,
            error_class: classifyWorkspaceCreateError(error),
            ...getCohortAtEmit()
          })
          throw error
        }
        finishAutomationWorkspaceProvenanceRequest(args.automationProvenanceRequest)
        track('workspace_created', {
          source,
          from_existing_branch: false,
          ...getCohortAtEmit()
        })
        notifyWorktreesChanged(mainWindow, repo.id)
        options?.onWorktreeLifecycle?.({
          kind: 'created',
          worktreeId: result.worktree.id,
          path: result.worktree.path,
          branch: result.worktree.branch
        })
        return { ...result, catalogVersion: getLocalWorktreeCatalogVersion(repo.id) }
      })
    }
  )
}
