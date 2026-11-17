import { buildRuntimeSetupReceipt } from '../../../runtime/workspaces/creation/runtime-local-worktree-setup'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { randomUUID } from 'node:crypto'
import type { Repo } from '../../../../shared/repository/repo-types'
import { getProjectHostSetupWorktreeMeta } from '../../../../shared/project/host-setup/project-host-setup-lookup'
import type { CreateWorktreeResult } from '../../../../shared/worktree/create-types'
import type { Store } from '../../../persistence/loading-store/store'
import type { CreateWorktreeArgsWithSystemProvenance } from '../ipc-context-schemas'
import { getFolderWorkspaceInstanceId, mergeFolderWorkspace } from '../folder-workspace-model'
import { resolveWorktreeCreateDisplayNameRequest } from '../../worktree-display-name'
import { hostWorktreeTargetForRepo } from '../../../persistence/host-qualified-worktree-meta'
import {
  isPreparedFolderSetup,
  prepareFolderWorktreeSetup
} from '../../../runtime/workspaces/creation/runtime-folder-worktree-setup'
import { getLocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'

export async function createFolderWorkspace(
  args: CreateWorktreeArgsWithSystemProvenance,
  repo: Repo,
  store: Store,
  runtime: Pick<
    OrcaRuntimeService,
    | 'startCreatedWorktreeTerminals'
    | 'beginWorkspaceSetup'
    | 'preparedWorkspaceSetup'
    | 'refuseWorkspaceSetup'
  >
): Promise<CreateWorktreeResult> {
  const now = Date.now()
  const instanceId = randomUUID()
  const worktreeId = getFolderWorkspaceInstanceId(repo, instanceId)
  const displayNameRequest = resolveWorktreeCreateDisplayNameRequest(
    args.displayName,
    args.displayNameKind,
    args.name,
    args.cliProvenance?.kind === 'created-by-cli',
    args.nameWasGenerated === true
  )
  const meta = store.setWorktreeMeta(hostWorktreeTargetForRepo(worktreeId, repo), {
    instanceId,
    ...(store.getProjectHostSetups
      ? getProjectHostSetupWorktreeMeta(store.getProjectHostSetups(), repo)
      : {}),
    displayName: displayNameRequest.value || args.name,
    ...(displayNameRequest.kind === 'user' && displayNameRequest.value
      ? { displayNameIsPinned: true }
      : {}),
    lastActivityAt: now,
    createdAt: now,
    orcaCreatedAt: now,
    orcaCreationSource: 'desktop',
    creatorProvenance: { kind: 'host' },
    ...(args.automationProvenance ? { automationProvenance: args.automationProvenance } : {}),
    ...(args.cliProvenance ? { cliProvenance: args.cliProvenance } : {}),
    ...(args.createdWithAgent ? { createdWithAgent: args.createdWithAgent } : {}),
    ...(args.linkedIssue !== undefined ? { linkedIssue: args.linkedIssue } : {}),
    ...(args.linkedPR !== undefined ? { linkedPR: args.linkedPR } : {}),
    ...(args.linkedLinearIssue !== undefined ? { linkedLinearIssue: args.linkedLinearIssue } : {}),
    ...(args.linkedLinearIssueWorkspaceId !== undefined
      ? { linkedLinearIssueWorkspaceId: args.linkedLinearIssueWorkspaceId }
      : {}),
    ...(args.linkedLinearIssueOrganizationUrlKey !== undefined
      ? { linkedLinearIssueOrganizationUrlKey: args.linkedLinearIssueOrganizationUrlKey }
      : {}),
    ...(args.manualOrder !== undefined ? { manualOrder: args.manualOrder } : {}),
    ...(args.workspaceStatus !== undefined ? { workspaceStatus: args.workspaceStatus } : {}),
    ...(args.linkedGitLabIssue !== undefined ? { linkedGitLabIssue: args.linkedGitLabIssue } : {}),
    ...(args.linkedGitLabMR !== undefined ? { linkedGitLabMR: args.linkedGitLabMR } : {}),
    ...(args.linkedBitbucketPR !== undefined ? { linkedBitbucketPR: args.linkedBitbucketPR } : {}),
    ...(args.linkedAzureDevOpsPR !== undefined
      ? { linkedAzureDevOpsPR: args.linkedAzureDevOpsPR }
      : {}),
    ...(args.linkedGiteaPR !== undefined ? { linkedGiteaPR: args.linkedGiteaPR } : {}),
    ...(args.linkedWorkItem !== undefined ? { linkedWorkItem: args.linkedWorkItem } : {}),
    ...(args.linkedItems !== undefined ? { linkedItems: args.linkedItems } : {}),
    ...(args.linkedTaskSourceContext !== undefined
      ? { linkedTaskSourceContext: args.linkedTaskSourceContext }
      : {})
  })
  runtime.beginWorkspaceSetup(worktreeId)
  try {
    const worktree = mergeFolderWorkspace(repo, worktreeId, meta)
    // The window opens the Setup tab from `setup`, as for a new worktree.
    const prepared = await prepareFolderWorktreeSetup({
      // A desktop create is the user's act, as for a new worktree.
      request: { ...args, wslUserAct: true },
      repo,
      worktree,
      settings: store.getSettings(),
      runtimeTarget: () => getLocalProjectWorktreeGitOptions(store, repo),
      shouldUseSetupRunner: true
    })
    const setup = isPreparedFolderSetup(prepared) ? prepared : undefined
    runtime.preparedWorkspaceSetup(worktreeId, setup?.requiredSetup === true)
    if (setup && (args.startup || args.startupDraft || setup.requiredSetup)) {
      const started = await runtime.startCreatedWorktreeTerminals({
        repo,
        worktree,
        setup: setup.setup,
        defaultTabs: setup.defaultTabs,
        setupPreparationFailure: setup.setupPreparationFailure,
        request: {
          ...args,
          activate: false,
          runHooks: false,
          repoSelector: repo.id,
          wslUserAct: true,
          awaitTerminalProvisioning: true,
          observeSetupCompletion: true,
          promisedAgentChat: Boolean(args.createdWithAgent && !args.startup && !args.startupDraft)
        }
      })
      return {
        worktree,
        setup: started.returnedSetup,
        setupReceipt: buildRuntimeSetupReceipt(
          setup,
          started.didSpawnSetup,
          started.setupTerminalHandle
        ),
        ...(setup.setupTrustMismatch ? { setupTrustMismatch: setup.setupTrustMismatch } : {}),
        ...(started.didSpawnStartup
          ? {
              startupTerminal: {
                spawned: true,
                handle: started.startupTerminalHandle ?? undefined,
                tabId: started.startupTerminalTabId ?? undefined,
                paneKey: started.startupTerminalPaneKey,
                ptyId: started.startupTerminalPtyId,
                surface: 'background' as const
              }
            }
          : {}),
        ...((started.warning ?? prepared?.warning)
          ? { warning: started.warning ?? prepared?.warning }
          : {})
      }
    }
    return {
      worktree,
      ...(setup?.setup ? { setup: setup.setup } : {}),
      ...(setup?.setupTrustMismatch ? { setupTrustMismatch: setup.setupTrustMismatch } : {}),
      ...(prepared?.warning ? { warning: prepared.warning } : {})
    }
  } catch (error) {
    runtime.refuseWorkspaceSetup(worktreeId)
    throw error
  }
}
