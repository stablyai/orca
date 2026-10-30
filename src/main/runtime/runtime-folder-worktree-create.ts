import type { PreparedTerminalPrompts } from '../daemon/prepared-agent-launch-protocol'
import { startRuntimeLocalWorktreeTerminals } from './runtime-local-worktree-terminal-startup'
import type { Worktree } from '../../shared/worktree/types'
import { shouldSeedWorktreePrimaryTerminal } from '../../shared/worktree-first-surface'
import { randomUUID } from 'node:crypto'
import { getProjectHostSetupWorktreeMeta } from '../../shared/project-host-setup-lookup'
import { resolveWorktreeCreateDisplayNameRequest } from '../ipc/worktree-display-name'
import type { RuntimeTerminalCreate } from '../../shared/runtime-types'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import type { Repo } from '../../shared/repo-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type { AgentLaunchRuntime } from '../../shared/agent-launch-runtime'
import {
  getRuntimeFolderWorkspaceInstanceId,
  mergeRuntimeFolderWorkspace
} from './runtime-folder-workspace'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import type { RuntimeStore } from './runtime-store-contract'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import type {
  WorktreeStartupDraftPaste,
  WorktreeStartupFollowup
} from './runtime-worktree-agent-startup'
import { hostWorktreeTargetForRepo } from '../persistence/host-qualified-worktree-meta'

type RuntimeFolderWorktreeCreateDeps = {
  store: RuntimeStore
  ptySpawnAvailable: boolean
  startPrepared?: (
    worktree: Worktree,
    options: TerminalCreateOptions,
    prompts: PreparedTerminalPrompts
  ) => ReturnType<
    NonNullable<Parameters<typeof startRuntimeLocalWorktreeTerminals>[0]['ports']['startPrepared']>
  >
  provisionInBackground?: () => boolean
  createTerminal: (
    selector: string,
    options: TerminalCreateOptions
  ) => Promise<RuntimeTerminalCreate>
  pasteDraft: (handle: string, draft: WorktreeStartupDraftPaste) => void
  sendFollowup: (handle: string, followup: WorktreeStartupFollowup) => void
  invalidateResolvedWorktrees: () => void
  notifyWorktreesChanged: (repoId: string) => void
  emitCreated: (event: {
    kind: 'created'
    worktreeId: string
    path: string
    branch: string
  }) => void
  activate: (
    repoId: string,
    worktreeId: string,
    setup?: undefined,
    startup?: WorktreeStartupLaunch,
    providesInitialSurface?: boolean
  ) => void
}

export async function createRuntimeFolderWorktree(args: {
  request: RuntimeManagedWorktreeCreateArgs
  repo: Repo
  startup?: WorktreeStartupLaunch
  startupFollowup?: WorktreeStartupFollowup
  /** What a host-built startup was quoted for, or the repair error it fails with. */
  startupLaunchRuntime?: AgentLaunchRuntime | Error
  createdWithAgent?: TuiAgent
  promisedAgentChat?: boolean
  onWorkspaceCreated?: (worktreeId: string) => void
  draftPaste?: WorktreeStartupDraftPaste
  deps: RuntimeFolderWorktreeCreateDeps
}): Promise<CreateWorktreeResult> {
  const { request, repo, deps } = args
  const now = Date.now()
  const settings = deps.store.getSettings()
  const instanceId = randomUUID()
  const worktreeId = getRuntimeFolderWorkspaceInstanceId(repo, instanceId)
  const displayNameRequest = resolveWorktreeCreateDisplayNameRequest(
    request.displayName,
    request.displayNameKind,
    request.name,
    request.cliProvenance?.kind === 'created-by-cli',
    request.nameWasGenerated === true
  )
  const resolvedFolderDisplayName = displayNameRequest.value
  const meta = deps.store.setWorktreeMeta(hostWorktreeTargetForRepo(worktreeId, repo), {
    instanceId,
    ...getProjectHostSetupWorktreeMeta(deps.store.getProjectHostSetups?.() ?? [], repo),
    displayName: resolvedFolderDisplayName ?? request.name,
    ...(displayNameRequest.kind === 'user' && resolvedFolderDisplayName
      ? { displayNameIsPinned: true }
      : {}),
    lastActivityAt: now,
    createdAt: now,
    orcaCreatedAt: now,
    orcaCreationSource: 'runtime',
    orcaCreationWorkspaceLayout: {
      path: settings.workspaceDir,
      nestWorkspaces: settings.nestWorkspaces
    },
    ...(request.automationProvenance ? { automationProvenance: request.automationProvenance } : {}),
    ...(request.cliProvenance ? { cliProvenance: request.cliProvenance } : {}),
    creatorProvenance: request.creatorProvenance ?? { kind: 'host' },
    ...(request.linkedIssue !== undefined ? { linkedIssue: request.linkedIssue } : {}),
    ...(request.linkedPR !== undefined ? { linkedPR: request.linkedPR } : {}),
    ...(request.linkedLinearIssue !== undefined
      ? { linkedLinearIssue: request.linkedLinearIssue }
      : {}),
    ...(request.linkedLinearIssueWorkspaceId !== undefined
      ? { linkedLinearIssueWorkspaceId: request.linkedLinearIssueWorkspaceId }
      : {}),
    ...(request.linkedLinearIssueOrganizationUrlKey !== undefined
      ? { linkedLinearIssueOrganizationUrlKey: request.linkedLinearIssueOrganizationUrlKey }
      : {}),
    ...(request.linkedGitLabIssue !== undefined
      ? { linkedGitLabIssue: request.linkedGitLabIssue }
      : {}),
    ...(request.linkedGitLabMR !== undefined ? { linkedGitLabMR: request.linkedGitLabMR } : {}),
    ...(request.linkedBitbucketPR !== undefined
      ? { linkedBitbucketPR: request.linkedBitbucketPR }
      : {}),
    ...(request.linkedAzureDevOpsPR !== undefined
      ? { linkedAzureDevOpsPR: request.linkedAzureDevOpsPR }
      : {}),
    ...(request.linkedGiteaPR !== undefined ? { linkedGiteaPR: request.linkedGiteaPR } : {}),
    ...(request.linkedWorkItem !== undefined ? { linkedWorkItem: request.linkedWorkItem } : {}),
    ...(request.linkedItems !== undefined ? { linkedItems: request.linkedItems } : {}),
    ...(request.linkedTaskSourceContext !== undefined
      ? { linkedTaskSourceContext: request.linkedTaskSourceContext }
      : {}),
    ...(args.createdWithAgent ? { createdWithAgent: args.createdWithAgent } : {}),
    ...(request.comment !== undefined ? { comment: request.comment } : {}),
    ...(request.manualOrder !== undefined ? { manualOrder: request.manualOrder } : {}),
    ...(request.workspaceStatus !== undefined ? { workspaceStatus: request.workspaceStatus } : {})
  })
  args.onWorkspaceCreated?.(worktreeId)
  const worktree = mergeRuntimeFolderWorkspace(repo, worktreeId, meta)
  deps.invalidateResolvedWorktrees()
  deps.notifyWorktreesChanged(repo.id)
  deps.emitCreated({
    kind: 'created',
    worktreeId: worktree.id,
    path: worktree.path,
    branch: worktree.branch
  })
  const startPrepared = deps.startPrepared
  const started = await startRuntimeLocalWorktreeTerminals({
    request,
    repo,
    worktree,
    startup: args.startup,
    startupFollowup: args.startupFollowup,
    startupLaunchRuntime: args.startupLaunchRuntime,
    createdWithAgent: args.createdWithAgent,
    promisedAgentChat: args.promisedAgentChat,
    draftPaste: args.draftPaste,
    ports: {
      canSpawn: deps.ptySpawnAvailable,
      ...(startPrepared
        ? { startPrepared: (options, prompts) => startPrepared(worktree, options, prompts) }
        : {}),
      provisionInBackground: deps.provisionInBackground,
      createTerminal: deps.createTerminal,
      pasteDraft: deps.pasteDraft,
      sendFollowup: deps.sendFollowup,
      provision: async ({ hasStartupTerminal }) => {
        if (
          shouldSeedWorktreePrimaryTerminal({
            hasPrimarySurface: hasStartupTerminal,
            callerProvidesSurface:
              args.promisedAgentChat === true || args.createdWithAgent !== undefined
          })
        ) {
          await deps.createTerminal(`id:${worktree.id}`, { surfaceOwner: false })
        }
        return { setupSpawned: false, setupTerminalHandle: null }
      },
      activate: (repoId, id, startup, _setup, _defaults, providesInitialSurface) =>
        providesInitialSurface !== undefined
          ? deps.activate(repoId, id, undefined, startup, providesInitialSurface)
          : deps.activate(repoId, id, undefined, startup)
    }
  })
  const startupTerminal: CreateWorktreeResult['startupTerminal'] = started.pendingStartup
    ? { spawned: false, pending: started.pendingStartup }
    : started.didSpawnStartup && started.startupTerminalHandle
      ? {
          spawned: true,
          handle: started.startupTerminalHandle,
          ...(started.startupTerminalTabId ? { tabId: started.startupTerminalTabId } : {}),
          ...(started.startupTerminalPaneKey ? { paneKey: started.startupTerminalPaneKey } : {}),
          ...(started.startupTerminalPtyId ? { ptyId: started.startupTerminalPtyId } : {}),
          surface: 'background'
        }
      : undefined
  return {
    worktree: {
      ...worktree,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git: {
        path: worktree.path,
        head: worktree.head,
        branch: worktree.branch,
        isBare: worktree.isBare,
        isMainWorktree: worktree.isMainWorktree
      }
    },
    ...(startupTerminal ? { startupTerminal } : {}),
    ...(started.warning ? { warning: started.warning } : {})
  }
}
