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
import { createPerforceCopyWorkspace } from '../perforce-copies/perforce-copy-workspace-creation'
import { findExactRepoOwner, isCapturedRepoCurrent } from '../listing/worktree-host-ownership'
import { requireWorktreeCreateRoute } from '../../../worktree-create-execution-host-route'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import { beginWorkspaceCreateTelemetry } from '../../../workspace-create-telemetry'

export function registerWorktreeCreateHandlers(context: WorktreeIpcContext): void {
  const { mainWindow, store, runtime, options } = context

  ipcMain.handle(
    'worktrees:create',
    async (_event, rawArgs: CreateWorktreeArgs): Promise<CreateWorktreeResult> => {
      const args = normalizeLinkedWorkItemFields(rawArgs)
      // Why span here: parent the child git spans for the trace tree; don't attach branch name/remote URL (user content) — repo ID is the safer correlator.
      return withWorktreeSpan({ stage: 'create' }, async (span) => {
        const repo = store.getRepo(args.repoId)
        if (!repo) {
          throw new Error(`Repo not found: ${args.repoId}`)
        }

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
        // The handler owns the events so a failed create can still say where it died.
        const telemetry = beginWorkspaceCreateTelemetry({
          source: args.telemetrySource,
          entryPoint: 'app',
          repoPath: repo.path,
          fromExistingBranch: typeof args.baseBranch === 'string' && args.baseBranch.length > 0,
          isFolder: isFolderRepo(repo)
        })
        try {
          // Why: wrap only the helpers; the pre-validation throws above are IPC-shape bugs, not the git/filesystem failures the funnel tracks.
          if (isFolderRepo(repo)) {
            // A folder workspace is a registration, not a filesystem create, so it is host-agnostic.
            result = createArgs.perforceCopy
              ? await createPerforceCopyWorkspace(createArgs, repo, store, mainWindow)
              : createFolderWorkspace(createArgs, repo, store)
          } else {
            // Resolve the host rather than reading the raw field: an `executionHostId: 'ssh:*'`-only
            // row read as local here and ran `git worktree add` on the client against a remote path,
            // while the runtime sibling on the same repo already resolved.
            const createRoute = requireWorktreeCreateRoute(repo)
            result =
              createRoute.kind === 'ssh'
                ? await createRemoteWorktree(
                    createArgs,
                    createRoute.repo,
                    store,
                    mainWindow,
                    telemetry.timing
                  )
                : await createLocalWorktree(
                    createArgs,
                    repo,
                    store,
                    mainWindow,
                    runtime,
                    telemetry.timing
                  )
          }
        } catch (error) {
          releaseAutomationWorkspaceProvenanceRequest(args.automationProvenanceRequest)
          telemetry.failed(error)
          throw error
        }
        finishAutomationWorkspaceProvenanceRequest(args.automationProvenanceRequest)
        if (result.timing) {
          addWorktreeCreatePhaseAttributes(span, result.timing)
        }

        // Why: reaching here means create succeeded (helpers throw); skip a separate workspace_initialized (telemetry-plan.md§Deferred); never send the branch name.
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

        // Why stamped last: the create's own change notification bumped the generation, so this
        // names the catalog that contains the new worktree.
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
