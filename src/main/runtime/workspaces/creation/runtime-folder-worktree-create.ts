import { formatTerminalStartFailure } from '../../../../shared/terminal/pty/lifecycle/terminal-start-failure'
import { readableWslDistroHoldText } from '../../../../shared/wsl-distro-stopped-hold'
import { RuntimeLineageError } from '../lineage/runtime-lineage-error'
import { paneIdentity } from '../../terminal/identity/runtime-terminal-pane-identity'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { shouldSeedWorktreePrimaryTerminal } from '../../../../shared/worktree-first-surface'
import { randomUUID } from 'node:crypto'
import { getProjectHostSetupWorktreeMeta } from '../../../../shared/project-host-setup-lookup'
import { resolveWorktreeCreateDisplayNameRequest } from '../../../ipc/worktree-display-name'
import type { CreateWorktreeResult } from '../../../../shared/worktree/create-types'
import type { Repo } from '../../../../shared/repo-types'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { WorktreeStartupLaunch } from '../../../../shared/worktree/launch-types'
import type { AgentLaunchRuntime } from '../../../../shared/agent-launch/startup/agent-launch-runtime'
import {
  getRuntimeFolderWorkspaceInstanceId,
  mergeRuntimeFolderWorkspace
} from '../catalog/runtime-folder-workspace'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import { createRuntimeFolderPerforceCopy } from './runtime-folder-perforce-copy'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type {
  WorktreeStartupDraftPaste,
  WorktreeStartupFollowup
} from '../startup/runtime-worktree-agent-startup'
import { hostWorktreeTargetForRepo } from '../../../persistence/host-qualified-worktree-meta'
import type { RuntimeLocalWorktreeTerminalPorts } from '../startup/runtime-local-worktree-terminal-startup'
import {
  isPreparedFolderSetup,
  prepareFolderWorktreeSetup,
  startRuntimeFolderWorktreeSetupTerminals,
  type RuntimeFolderWorktreeSetupDeps
} from './runtime-folder-worktree-setup'
import { buildRuntimeSetupReceipt } from './runtime-local-worktree-setup'
import { createdWorktreeLifecycleIdentity } from '../lifecycle/worktree-lifecycle-event'

type RuntimeFolderWorktreeCreateDeps = {
  store: RuntimeStore
  /** The same terminal operations a worktree create uses; folder startup and setup share them. */
  terminals: RuntimeLocalWorktreeTerminalPorts
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
  /** Absent where this host can't run the folder's setup script. */
  setup?: RuntimeFolderWorktreeSetupDeps
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
  // Inferred parents fall away here, as same-machine folder creates record none.
  if (request.lineage?.crossStoreParent && !request.lineage.crossStoreParentInferredFrom) {
    throw new RuntimeLineageError(
      'LINEAGE_PARENT_CONTEXT_CONFLICT',
      "A folder workspace can't have a parent on another machine yet."
    )
  }
  const now = Date.now()
  const settings = deps.store.getSettings()
  const instanceId = randomUUID()
  const copy = await createRuntimeFolderPerforceCopy(repo, request, settings)
  const worktreeId = copy?.worktreeId ?? getRuntimeFolderWorkspaceInstanceId(repo, instanceId)
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
    ...(request.workspaceStatus !== undefined ? { workspaceStatus: request.workspaceStatus } : {}),
    ...copy?.meta
  })
  copy?.recorded()
  args.onWorkspaceCreated?.(worktreeId)
  const worktree = mergeRuntimeFolderWorkspace(repo, worktreeId, meta)
  deps.invalidateResolvedWorktrees()
  deps.notifyWorktreesChanged(repo.id)
  deps.emitCreated({
    kind: 'created',
    worktreeId: worktree.id,
    path: worktree.path,
    branch: worktree.branch,
    ...createdWorktreeLifecycleIdentity(worktree)
  })
  const setupResult = deps.setup
    ? await prepareFolderWorktreeSetup({
        request,
        repo,
        worktree,
        settings,
        runtimeTarget: deps.setup.runtimeTarget,
        shouldUseSetupRunner: deps.setup.shouldUseSetupRunner
      })
    : undefined
  const preparedSetup = isPreparedFolderSetup(setupResult) ? setupResult : undefined
  if (preparedSetup?.setup && deps.setup) {
    return {
      worktree: folderCreateResultWorktree(worktree),
      ...(await startRuntimeFolderWorktreeSetupTerminals({
        request,
        repo,
        worktree,
        prepared: preparedSetup,
        startup: args.startup,
        startupFollowup: args.startupFollowup,
        startupLaunchRuntime: args.startupLaunchRuntime,
        createdWithAgent: args.createdWithAgent,
        promisedAgentChat: args.promisedAgentChat,
        draftPaste: args.draftPaste,
        terminals: deps.terminals
      }))
    }
  }
  const shouldActivate = request.activate === true || request.runHooks === true
  let warning: string | undefined = setupResult?.warning
  let didSpawnStartup = false
  let startupTerminal: CreateWorktreeResult['startupTerminal']
  // Main owns failed agent startup too, so its pane can show the reason without a terminal service.
  if (args.startup && (deps.terminals.canSpawn || ORCA_LAYOUT_OWNER_IS_MAIN)) {
    try {
      const launchRuntime = args.startupLaunchRuntime
      if (launchRuntime instanceof Error && !ORCA_LAYOUT_OWNER_IS_MAIN) {
        throw launchRuntime
      }
      const terminal = await deps.terminals.createTerminal(`id:${worktree.id}`, {
        command: args.startup.command,
        ...(request.startupCwd ? { cwd: request.startupCwd } : {}),
        ...paneIdentity(request.startupPaneKey),
        env: args.startup.env,
        ...(args.startup.launchConfig ? { launchConfig: args.startup.launchConfig } : {}),
        ...(args.createdWithAgent ? { launchAgent: args.createdWithAgent } : {}),
        ...(launchRuntime instanceof Error
          ? { startFailure: launchRuntime }
          : launchRuntime
            ? { launchRuntime }
            : {}),
        ...(args.startup.viewMode ? { viewMode: args.startup.viewMode } : {}),
        startupCommandDelivery: args.startup.startupCommandDelivery,
        telemetry: args.startup.telemetry,
        // Keep failed main-owned starts visible in their panes.
        ...(ORCA_LAYOUT_OWNER_IS_MAIN ? { keepPaneOnStartFailure: true as const } : {}),
        ...(shouldActivate ? {} : { surfaceOwner: false })
      })
      request.onStartupTerminalCreated?.(terminal)
      if (args.draftPaste) {
        deps.terminals.pasteDraft(terminal.handle, args.draftPaste)
      }
      if (args.startupFollowup) {
        deps.terminals.sendFollowup(terminal.handle, args.startupFollowup, terminal)
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
      const message = readableWslDistroHoldText(
        formatTerminalStartFailure(error) ??
          (error instanceof Error ? error.message : String(error))
      )
      warning = `Failed to create the startup terminal for ${worktree.path}: ${message}`
      console.warn(`[worktree-create] ${warning}`)
    }
  }
  if (shouldActivate) {
    deps.activate(
      repo.id,
      worktree.id,
      undefined,
      // Main retains failed startup presentation; the window must not take it over.
      ORCA_LAYOUT_OWNER_IS_MAIN
        ? undefined
        : args.startup && !didSpawnStartup
          ? args.startup
          : undefined,
      ...(args.promisedAgentChat && !args.startup ? ([true] as const) : [])
    )
  }
  if (
    (!shouldActivate || deps.terminals.provisionInBackground?.() === true) &&
    deps.terminals.canSpawn &&
    shouldSeedWorktreePrimaryTerminal({
      // Failed agents retain their panes; do not seed a shell beside them.
      hasPrimarySurface: didSpawnStartup || (ORCA_LAYOUT_OWNER_IS_MAIN && Boolean(args.startup)),
      // Background attribution-only creates have historically omitted the shell.
      callerProvidesSurface: args.promisedAgentChat === true || args.createdWithAgent !== undefined
    })
  ) {
    try {
      await deps.terminals.createTerminal(`id:${worktree.id}`, { surfaceOwner: false })
    } catch (error) {
      const message = readableWslDistroHoldText(
        formatTerminalStartFailure(error) ??
          (error instanceof Error ? error.message : String(error))
      )
      const initialWarning = `Failed to create the initial terminal for ${worktree.path}: ${message}`
      warning = warning
        ? `${warning} Also failed to create the initial terminal for ${worktree.path}: ${message}`
        : initialWarning
      console.warn(`[worktree-create] ${warning}`)
    }
  }
  return {
    worktree: folderCreateResultWorktree(worktree),
    ...(startupTerminal ? { startupTerminal } : {}),
    ...(preparedSetup && request.awaitTerminalProvisioning
      ? { setupReceipt: buildRuntimeSetupReceipt(preparedSetup, false, null) }
      : {}),
    // The window re-asks with this content, then runs the approved setup.
    ...(preparedSetup?.setupTrustMismatch
      ? { setupTrustMismatch: preparedSetup.setupTrustMismatch }
      : {}),
    ...(warning ? { warning } : {}),
    ...copy?.result
  }
}

function folderCreateResultWorktree(
  worktree: ReturnType<typeof mergeRuntimeFolderWorkspace>
): CreateWorktreeResult['worktree'] {
  return {
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
  }
}
