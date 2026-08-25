import { ipcMain, app } from 'electron'
import type {
  CreateWorktreeArgs,
  CreateWorktreeResult,
  AdoptProvisionedRootArgs
} from '../../../../shared/worktree/create-types'
import { withWorktreeSpan } from '../../../observability/instrumentation'
import { workspaceSourceSchema } from '../../../../shared/telemetry-events'
import type { WorkspaceSource } from '../../../../shared/telemetry-events'
import {
  resolveAutomationWorkspaceProvenance,
  releaseAutomationWorkspaceProvenanceRequest,
  finishAutomationWorkspaceProvenanceRequest
} from '../../../automations/workspace-provenance'
import { isFolderRepo } from '../../../../shared/repo-kind'
import {
  createRemoteWorktree,
  createLocalWorktree,
  notifyWorktreesChanged
} from '../../worktree-remote'
import { track } from '../../../telemetry/client'
import { classifyWorkspaceCreateError } from '../../workspace-create-error-classifier'
import { getCohortAtEmit } from '../../../telemetry/cohort-classifier'
import { adoptProvisionedRootSshCheckout } from '../../../provisioned-root-ssh-adoption'
import { normalizeLinkedWorkItemFields } from '../ipc-context-schemas'
import type { CreateWorktreeArgsWithSystemProvenance } from '../ipc-context-schemas'
import { createFolderWorkspace } from './folder-workspace-creation'
import { findExactRepoOwner, isCapturedRepoCurrent } from '../listing/worktree-host-ownership'
import type { WorktreeIpcContext } from '../worktree-ipc-context'

export function registerWorktreeCreateHandlers(context: WorktreeIpcContext): void {
  const { mainWindow, store, runtime, options } = context

  ipcMain.handle(
    'worktrees:create',
    async (_event, rawArgs: CreateWorktreeArgs): Promise<CreateWorktreeResult> => {
      const args = normalizeLinkedWorkItemFields(rawArgs)
      // Why span here: parent the child git spans for the trace tree; don't attach branch name/remote URL (user content) — repo ID is the safer correlator.
      return withWorktreeSpan({ stage: 'create' }, async () => {
        const repo = store.getRepo(args.repoId)
        if (!repo) {
          throw new Error(`Repo not found: ${args.repoId}`)
        }

        const sourceParse = workspaceSourceSchema.safeParse(args.telemetrySource)
        const source: WorkspaceSource = sourceParse.success ? sourceParse.data : 'unknown'

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
        try {
          // Why: wrap only the helpers; the pre-validation throws above are IPC-shape bugs, not the git/filesystem failures the funnel tracks.
          result = isFolderRepo(repo)
            ? createFolderWorkspace(createArgs, repo, store)
            : repo.connectionId
              ? await createRemoteWorktree(createArgs, repo, store, mainWindow)
              : await createLocalWorktree(createArgs, repo, store, mainWindow, runtime)
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

        // Why: reaching here means create succeeded (helpers throw); skip a separate workspace_initialized (telemetry-plan.md§Deferred); never send the branch name.
        track('workspace_created', {
          source,
          from_existing_branch:
            !isFolderRepo(repo) &&
            typeof args.baseBranch === 'string' &&
            args.baseBranch.length > 0,
          ...getCohortAtEmit()
        })

        if (isFolderRepo(repo)) {
          notifyWorktreesChanged(mainWindow, repo.id)
        }

        options?.onWorktreeLifecycle?.({
          kind: 'created',
          worktreeId: result.worktree.id,
          path: result.worktree.path,
          branch: result.worktree.branch
        })

        return result
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
        return result
      })
    }
  )
}
