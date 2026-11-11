import { ipcMain, app } from 'electron'
import { getLocalWorktreeCatalogVersion } from '../../../workspaces/catalog/local-worktree-scan-generation'
import type {
  CreateWorktreeArgs,
  CreateWorktreeResult,
  AdoptProvisionedRootArgs,
  RunApprovedWorktreeSetupArgs,
  RunApprovedWorktreeSetupResult
} from '../../../../shared/worktree/create-types'
import { runApprovedCreatedWorktreeSetup } from '../../../runtime/workspaces/creation/created-worktree-approved-setup'
import {
  addWorktreeCreatePhaseAttributes,
  withWorktreeSpan
} from '../../../observability/instrumentation'
import { workspaceSourceSchema, type WorkspaceSource } from '../../../../shared/telemetry-events'

import { isFolderRepo } from '../../../../shared/repo-kind'
import { createLocalWorktree, notifyWorktreesChanged } from '../../worktree-remote'
import { SshHostNotServedError } from '../../../providers/ssh-host-not-served-error'
import { track } from '../../../telemetry/client'
import { classifyWorkspaceCreateError } from '../../workspace-create-error-classifier'
import { getCohortAtEmit } from '../../../telemetry/cohort-classifier'
import { adoptProvisionedRootSshCheckout } from '../../../workspaces/catalog/provisioned-root-ssh-adoption'
import { normalizeLinkedWorkItemFields } from '../ipc-context-schemas'
import { createFolderWorkspace } from './folder-workspace-creation'
import { createPerforceCopyWorkspace } from '../perforce-copies/perforce-copy-workspace-creation'
import { findExactRepoOwner, isCapturedRepoCurrent } from '../listing/worktree-host-ownership'
import { requireWorktreeCreateRoute } from '../../../workspaces/creation/worktree-create-execution-host-route'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { workspaceLifecycleKey } from '../../../runtime/workspaces/lifecycle/workspace-lifecycle-commands'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import { beginWorkspaceCreateTelemetry } from '../../../workspaces/creation/workspace-create-telemetry'
import { assertWslMoveRepoWritable } from '../../../persistence/moving-wsl-projects/quiescence/wsl-move-scope-guard'
import { applyWorkspaceCreatePluginHook } from '../../../plugins/hooks/workspace-create-plugin-hook'
import { withProjectWorktreeCreate } from '../../../workspaces/creation/worktree-create-in-flight'

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
        return withProjectWorktreeCreate(repo, async () => {
          const createArgs = await applyWorkspaceCreatePluginHook(args, repo)

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
              // Folder creation registers metadata; its setup prep checks ownership itself.
              result = createArgs.perforceCopy
                ? await createPerforceCopyWorkspace(createArgs, repo, store, mainWindow)
                : await createFolderWorkspace(createArgs, repo, store)
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
            telemetry.failed(error)
            throw error
          } finally {
            creation?.close()
          }
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
      })
    }
  )

  ipcMain.handle(
    'worktrees:runApprovedSetup',
    (_event, args: RunApprovedWorktreeSetupArgs): Promise<RunApprovedWorktreeSetupResult> =>
      // A click on the trust prompt is the user's act, so it may start the repo's WSL distro.
      runApprovedCreatedWorktreeSetup(runtime, `id:${args.worktreeId}`, args.approvedSetupHash, {
        wslUserAct: true
      })
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
        let result: CreateWorktreeResult
        try {
          result = await adoptProvisionedRootSshCheckout({
            userDataPath: app.getPath('userData'),
            request: args,
            repo,
            store,
            isRepoCurrent: () => isCapturedRepoCurrent(store, repo, args.executionHostId)
          })
        } catch (error) {
          track('workspace_create_failed', {
            source,
            error_class: classifyWorkspaceCreateError(error),
            ...getCohortAtEmit()
          })
          throw error
        }
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
