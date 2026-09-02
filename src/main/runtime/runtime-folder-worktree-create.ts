import { randomUUID } from 'node:crypto'
import { getProjectHostSetupWorktreeMeta } from '../../shared/project-host-setup-lookup'
import { resolveWorktreeCreateDisplayNameRequest } from '../ipc/worktree-logic'
import type { RuntimeTerminalCreate } from '../../shared/runtime-types'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import type { Repo } from '../../shared/repo-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
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

type RuntimeFolderWorktreeCreateDeps = {
  store: RuntimeStore
  ptySpawnAvailable: boolean
  createTerminal: (
    selector: string,
    options: TerminalCreateOptions
  ) => Promise<RuntimeTerminalCreate>
  markTrusted: (agent: TuiAgent, path: string) => Promise<void>
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
    startup?: WorktreeStartupLaunch
  ) => void
}

export async function createRuntimeFolderWorktree(args: {
  request: RuntimeManagedWorktreeCreateArgs
  repo: Repo
  startup?: WorktreeStartupLaunch
  startupFollowup?: WorktreeStartupFollowup
  createdWithAgent?: TuiAgent
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
  const meta = deps.store.setWorktreeMeta(worktreeId, {
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
    ...(request.linkedTaskSourceContext !== undefined
      ? { linkedTaskSourceContext: request.linkedTaskSourceContext }
      : {}),
    ...(args.createdWithAgent ? { createdWithAgent: args.createdWithAgent } : {}),
    ...(request.comment !== undefined ? { comment: request.comment } : {}),
    ...(request.manualOrder !== undefined ? { manualOrder: request.manualOrder } : {}),
    ...(request.workspaceStatus !== undefined ? { workspaceStatus: request.workspaceStatus } : {})
  })
  const worktree = mergeRuntimeFolderWorkspace(repo, worktreeId, meta)
  deps.invalidateResolvedWorktrees()
  deps.notifyWorktreesChanged(repo.id)
  deps.emitCreated({
    kind: 'created',
    worktreeId: worktree.id,
    path: worktree.path,
    branch: worktree.branch
  })
  const shouldActivate = request.activate === true || request.runHooks === true
  let warning: string | undefined
  let didSpawnStartup = false
  let startupTerminal: CreateWorktreeResult['startupTerminal']
  if (args.startup && deps.ptySpawnAvailable) {
    try {
      const trustAgent = args.draftPaste?.agent ?? args.createdWithAgent
      if (trustAgent) {
        await deps.markTrusted(trustAgent, worktree.path)
      }
      const terminal = await deps.createTerminal(`id:${worktree.id}`, {
        command: args.startup.command,
        env: args.startup.env,
        ...(args.startup.launchConfig ? { launchConfig: args.startup.launchConfig } : {}),
        ...(args.createdWithAgent ? { launchAgent: args.createdWithAgent } : {}),
        ...(args.startup.viewMode ? { viewMode: args.startup.viewMode } : {}),
        startupCommandDelivery: args.startup.startupCommandDelivery,
        telemetry: args.startup.telemetry,
        ...(shouldActivate ? {} : { surfaceOwner: false })
      })
      if (args.draftPaste) {
        deps.pasteDraft(terminal.handle, args.draftPaste)
      }
      if (args.startupFollowup) {
        deps.sendFollowup(terminal.handle, args.startupFollowup)
      }
      didSpawnStartup = true
      startupTerminal = {
        spawned: true,
        handle: terminal.handle,
        ...(terminal.tabId ? { tabId: terminal.tabId } : {}),
        ...(terminal.paneKey ? { paneKey: terminal.paneKey } : {}),
        ...(terminal.ptyId ? { ptyId: terminal.ptyId } : {}),
        surface: 'background'
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warning = `Failed to create the startup terminal for ${worktree.path}: ${message}`
      console.warn(`[worktree-create] ${warning}`)
    }
  }
  if (shouldActivate) {
    deps.activate(
      repo.id,
      worktree.id,
      undefined,
      args.startup && !didSpawnStartup ? args.startup : undefined
    )
  } else if (deps.ptySpawnAvailable && !didSpawnStartup) {
    try {
      await deps.createTerminal(`id:${worktree.id}`, { surfaceOwner: false })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const initialWarning = `Failed to create the initial terminal for ${worktree.path}: ${message}`
      warning = warning
        ? `${warning} Also failed to create the initial terminal for ${worktree.path}: ${message}`
        : initialWarning
      console.warn(`[worktree-create] ${warning}`)
    }
  }
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
    ...(warning ? { warning } : {})
  }
}
