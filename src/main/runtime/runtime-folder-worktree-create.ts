import { attemptWorktreeTerminalStartup } from './runtime-worktree-terminal-startup-attempt'
import { navigationTargetsHost } from '../../shared/runtime-navigation'
import { paneIdentity } from './runtime-terminal-pane-identity'
import { shouldSeedWorktreePrimaryTerminal } from '../../shared/worktree-first-surface'
import { randomUUID } from 'node:crypto'
import { getProjectHostSetupWorktreeMeta } from '../../shared/project-host-setup-lookup'
import { resolveWorktreeCreateDisplayNameRequest } from '../ipc/worktree-logic'
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

type RuntimeFolderWorktreeCreateDeps = {
  store: RuntimeStore
  ptySpawnAvailable: boolean
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
  /** A running creation operation builds this workspace's first surface itself. */
  launchOwnsFirstSurface?: (worktreeId: string) => boolean
}

export async function createRuntimeFolderWorktree(args: {
  request: RuntimeManagedWorktreeCreateArgs
  repo: Repo
  startup?: WorktreeStartupLaunch
  startupFollowup?: WorktreeStartupFollowup
  /** What a host-built startup was quoted for, or the repair error it fails with. */
  startupLaunchRuntime?: AgentLaunchRuntime | Error
  createdWithAgent?: TuiAgent
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
  const shouldActivate = request.activate === true || request.runHooks === true
  let warning: string | undefined
  let didSpawnStartup = false
  let startupTerminal: CreateWorktreeResult['startupTerminal']
  const launchOwnsSurface = deps.launchOwnsFirstSurface?.(worktree.id) === true
  const surfacing =
    shouldActivate && navigationTargetsHost(request.navigation ?? 'host')
      ? {}
      : { surfaceOwner: false as const }
  let startupFailure: Awaited<ReturnType<typeof attemptWorktreeTerminalStartup>>['failure']
  if (args.startup) {
    const attempted = await attemptWorktreeTerminalStartup({
      selector: `id:${worktree.id}`,
      options: {
        command: args.startup.command,
        ...(request.startupCwd ? { cwd: request.startupCwd } : {}),
        ...paneIdentity(request.startupPaneKey),
        env: args.startup.env,
        ...(args.startup.launchConfig ? { launchConfig: args.startup.launchConfig } : {}),
        ...(args.createdWithAgent ? { launchAgent: args.createdWithAgent } : {}),
        ...(args.startupLaunchRuntime && !(args.startupLaunchRuntime instanceof Error)
          ? { launchRuntime: args.startupLaunchRuntime }
          : {}),
        ...(args.startup.viewMode ? { viewMode: args.startup.viewMode } : {}),
        startupCommandDelivery: args.startup.startupCommandDelivery,
        telemetry: args.startup.telemetry,
        ...surfacing
      },
      ...(args.startupLaunchRuntime instanceof Error
        ? { runtimeError: args.startupLaunchRuntime }
        : {}),
      canSpawn: deps.ptySpawnAvailable,
      owned: launchOwnsSurface,
      recoveryOptions: surfacing,
      create: deps.createTerminal
    })
    startupFailure = attempted.failure
    const terminal = attempted.agentTerminal
    if (terminal) {
      if (args.draftPaste) {
        deps.pasteDraft(terminal.handle, args.draftPaste)
      }
      if (args.startupFollowup) {
        deps.sendFollowup(terminal.handle, args.startupFollowup)
      }
      didSpawnStartup = true
      startupTerminal = { spawned: true, ...terminal, surface: 'background' }
    } else if (startupFailure) {
      warning = `Failed to create the startup terminal for ${worktree.path}: ${startupFailure.message}`
      console.warn(`[worktree-create] ${warning}`)
    }
  }
  if (shouldActivate) {
    try {
      deps.activate(
        repo.id,
        worktree.id,
        undefined,
        args.startup && !didSpawnStartup && !launchOwnsSurface ? args.startup : undefined,
        launchOwnsSurface || undefined
      )
    } catch (error) {
      if (!startupFailure) {
        throw error
      }
      startupFailure.provisioningCauses.push(error)
    }
  }
  if (
    (!shouldActivate || deps.provisionInBackground?.() === true) &&
    deps.ptySpawnAvailable &&
    shouldSeedWorktreePrimaryTerminal({
      hasPrimarySurface: didSpawnStartup,
      // Background attribution-only creates have historically omitted the shell.
      callerProvidesSurface: launchOwnsSurface || args.createdWithAgent !== undefined
    })
  ) {
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
  if (launchOwnsSurface && startupFailure) {
    throw startupFailure
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
