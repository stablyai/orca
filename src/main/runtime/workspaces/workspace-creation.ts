import type { Repo } from '../../../shared/repo-types'
import type {
  WorktreeLineageInput,
  WorktreeLineageResolution
} from '../runtime-worktree-lineage-resolution'
import { OrcaRuntimeWithGetWorktreeTerminalProvisioningHost } from './startup/workspace-terminal-provisioning'
import type { RuntimeManagedWorktreeCreateArgs } from '../runtime-managed-worktree-create-types'
import type { CreateWorktreeResult } from '../../../shared/worktree/create-types'
import { isFolderRepo } from '../../../shared/repo-kind'
import { notifyLineageRepos } from '../../worktree-lineage-change-notification'
import { resolveWorktreeCreateRoute } from '../../worktree-create-execution-host-route'
import { ExecutionHostNotDispatchableError } from '../../providers/execution-host-provider-dispatch'
import { SshHostNotServedError } from '../../providers/ssh-host-not-served-error'
import { createRuntimeFolderWorktree } from '../runtime-folder-worktree-create'
import { createRuntimeLocalManagedWorktree } from '../runtime-local-worktree-create'
import type { PreparationRearmHolder } from '../../worktree-create-preparation'
import { prepareRuntimeLocalWorktreeSetup } from '../runtime-local-worktree-setup'
import { invalidateAuthorizedRootsCacheForRepo } from '../../ipc/registered-worktree-roots-scoped-invalidation'
import { startRuntimeLocalWorktreeTerminals } from '../runtime-local-worktree-terminal-startup'
import { trackRuntimeWorkspaceCreate } from '../../workspace-create-telemetry'
import { assertOpenCodeModelLaunchPreferencesAbsent } from '../../opencode/opencode-model-startup-plan'
import type { RuntimeWorkspaceCreateEvents } from '../../workspace-create-telemetry'
import { createdWorkspaceActivationCallbacks } from './workspace-create-activation'
import { assertWslMoveRepoWritable } from '../../persistence/moving-wsl-projects/wsl-move-scope-guard'
import { resolveManagedWorktreeCreateStartup } from './managed-worktree-create-startup'
import { WorkspaceLifecycleQueue } from './workspace-lifecycle-queue'
import type { WorkspaceCreationHandle } from './workspace-lifecycle-creations'
import { workspaceLifecycleKey } from './workspace-lifecycle-commands'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-inputs-switch'

export abstract class OrcaRuntimeWithCreateManagedWorktree extends OrcaRuntimeWithGetWorktreeTerminalProvisioningHost {
  protected abstract resolveLineageForWorktreeCreate(
    input?: WorktreeLineageInput,
    childRepo?: Repo
  ): Promise<WorktreeLineageResolution>

  // Switch point: only a build where main produces the sidebar's inputs queues lifecycle commands.
  readonly workspaceLifecycle = ORCA_SIDEBAR_INPUTS_IS_MAIN ? new WorkspaceLifecycleQueue() : null

  async createManagedWorktree(
    args: RuntimeManagedWorktreeCreateArgs
  ): Promise<CreateWorktreeResult> {
    // Re-arm a consumed checkout after terminal startup, including failed creates.
    const rearm: PreparationRearmHolder = { fire: () => {} }
    try {
      return await trackRuntimeWorkspaceCreate(args, (events) =>
        this.performManagedWorktreeCreate(args, rearm, events)
      )
    } finally {
      rearm.fire()
    }
  }

  private async performManagedWorktreeCreate(
    args: RuntimeManagedWorktreeCreateArgs,
    rearm: PreparationRearmHolder,
    events: RuntimeWorkspaceCreateEvents
  ): Promise<CreateWorktreeResult> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }

    assertOpenCodeModelLaunchPreferencesAbsent(
      args.startupAgent ?? args.createdWithAgent,
      args.startupLaunchPreferences
    )

    const repo = await this.resolveRepoSelector(args.repoSelector)
    // Listed from here: a create refused before its project resolved has nothing to show.
    const creation = this.workspaceLifecycle?.openCreate({
      creationId: args.creationId,
      repoId: repo.id,
      keyOf: (worktreeId) => workspaceLifecycleKey(getRepoExecutionHostId(repo), worktreeId)
    })
    try {
      return await this.createInResolvedProject(args, repo, creation, rearm, events)
    } finally {
      creation?.close()
    }
  }

  private async createInResolvedProject(
    args: RuntimeManagedWorktreeCreateArgs,
    repo: Repo,
    creation: WorkspaceCreationHandle | undefined,
    rearm: PreparationRearmHolder,
    events: RuntimeWorkspaceCreateEvents
  ): Promise<CreateWorktreeResult> {
    const store = this.requireStore()
    const onWorkspaceCreated = (worktreeId: string): void => {
      creation?.named(worktreeId)
      args.onWorkspaceCreated?.(worktreeId)
    }
    assertWslMoveRepoWritable(store, repo)
    const createSettings = store.getSettings()
    const {
      effectiveStartup,
      effectiveStartupFollowup,
      startupLaunchRuntime,
      effectiveCreatedWithAgent,
      effectiveDraftPaste
    } = await resolveManagedWorktreeCreateStartup(args, createSettings.disabledTuiAgents, {
      agent: (...inputs) => this.buildStartupForAgent(repo, ...inputs),
      draft: (...inputs) => this.buildStartupForDraft(repo, ...inputs)
    })
    const activationCallbacks = createdWorkspaceActivationCallbacks(
      this.notifyActivateWorktree.bind(this),
      args.navigation
    )
    // Match IPC routing: executionHostId-only SSH repos must not create locally.
    const createRoute = resolveWorktreeCreateRoute(repo)
    if (isFolderRepo(repo)) {
      // A folder workspace is a registration, not a filesystem create, so it is host-agnostic.
      return createRuntimeFolderWorktree({
        request: args,
        repo,
        startup: effectiveStartup,
        startupFollowup: effectiveStartupFollowup,
        startupLaunchRuntime,
        createdWithAgent: effectiveCreatedWithAgent,
        promisedAgentChat: args.promisedAgentChat,
        onWorkspaceCreated,
        draftPaste: effectiveDraftPaste,
        deps: {
          store,
          ptySpawnAvailable: Boolean(this.ptyController?.spawn),
          provisionInBackground: () => this.shouldProvisionWorktreeInBackground(args.navigation),
          createTerminal: (selector, options) => this.createTerminal(selector, options),
          pasteDraft: (handle, draft) => this.pasteStartupDraftWhenReady(handle, draft),
          sendFollowup: (handle, followup) => this.sendStartupFollowupWhenReady(handle, followup),
          invalidateResolvedWorktrees: () => this.invalidateResolvedWorktreeCache(),
          notifyWorktreesChanged: (repoId) => this.notifyWorktreesChanged(repoId),
          emitCreated: (event) => this.emitWorktreeLifecycle(event),
          activate: activationCallbacks.folder
        }
      })
    }
    const lineageInput =
      args.lineage || args.comment ? { ...args.lineage, comment: args.comment } : undefined
    const lineageResolution = await this.resolveLineageForWorktreeCreate(lineageInput, repo)
    if (createRoute.kind === 'runtime') {
      throw new ExecutionHostNotDispatchableError(createRoute.hostId)
    }
    const timing = events.begin(repo.path)
    if (createRoute.kind === 'ssh') {
      // Tagged before the refusal so the failed-create event keeps naming its host.
      timing.recordExecutionHost('ssh')
      throw new SshHostNotServedError(createRoute.connectionId)
    }
    const localCreate = await createRuntimeLocalManagedWorktree({
      request: args,
      repo,
      store: this.requireStore(),
      createdWithAgent: effectiveCreatedWithAgent,
      hostedReviewExecutionContext: this.getHostedReviewExecutionOptions(repo),
      resolveRemoteTrackingBase: (path, base, ...options) =>
        this.resolveRemoteTrackingBase(path, base, ...options),
      hasRemoteTrackingRef: (path, base, ...options) =>
        this.hasRemoteTrackingRef(path, base, ...options),
      refreshRemoteTrackingBase: (path, base, ...options) =>
        this.getOrStartRemoteTrackingBaseRefresh(path, base, ...options),
      fetchRemote: (path, remote, ...options) =>
        this.fetchRemoteWithCache(path, remote, ...options),
      onWorktreeMetadataPersisted: (persistedWorktree) => {
        onWorkspaceCreated(persistedWorktree.id)
        return this.recordCreatedWorktreeLineage(persistedWorktree, lineageResolution)
      },
      rearm,
      timing
    })
    const { worktree, worktreePath, includeCopyWarning, created, addResult, metadataResult } =
      localCreate
    const settings = createSettings
    const { lineage, workspaceLineage, warnings: lineageWarnings } = metadataResult

    let {
      setup,
      defaultTabs,
      warning,
      effectiveDecision,
      hookFound,
      shouldRunSetup,
      didStartInProcessSetupHook
    } = await prepareRuntimeLocalWorktreeSetup({
      request: args,
      repo,
      worktreePath,
      settings,
      runtimeTarget: this.getLocalGitExecutionOptionArgs(repo)[0],
      shouldUseSetupRunner:
        this.authoritativeWindowId !== null ||
        Boolean(effectiveStartup) ||
        Boolean(this.ptyController?.spawn),
      warning: includeCopyWarning
    })

    this.invalidateResolvedWorktreeCache()
    this.invalidateWorktreeScanCacheForRepo(repo.id)
    // Why: the filesystem-auth layer maintains a separate cache of registered
    // worktree roots used by git IPC handlers (branchCompare, diff, status, etc.)
    // to authorize paths. Without invalidating it here, CLI-created worktrees
    // are not recognized and all git operations fail with "Access denied:
    // unknown repository or worktree path".
    // Scoped to this repo: the global form dirties every owner, so the next
    // authorization-requiring IPC relists EVERY registered repo — ~58 `git worktree
    // list` spawns, ~10s of git wall-clock through an admission budget of 4, to
    // rediscover roots only this repo changed.
    invalidateAuthorizedRootsCacheForRepo(store, repo)

    notifyLineageRepos(this.notifyWorktreesChanged.bind(this), repo.id, lineage?.parentWorktreeId)
    const {
      warning: terminalWarning,
      returnedSetup,
      didSpawnSetup,
      didSpawnStartup,
      setupTerminalHandle,
      startupTerminalHandle,
      startupTerminalTabId,
      startupTerminalPaneKey,
      startupTerminalPtyId
    } = await startRuntimeLocalWorktreeTerminals({
      request: args,
      repo,
      worktree,
      setup,
      defaultTabs,
      startup: effectiveStartup,
      startupFollowup: effectiveStartupFollowup,
      startupLaunchRuntime,
      createdWithAgent: effectiveCreatedWithAgent,
      promisedAgentChat: args.promisedAgentChat,
      draftPaste: effectiveDraftPaste,
      warning,
      ports: {
        canSpawn: Boolean(this.ptyController?.spawn),
        provisionInBackground: () => this.shouldProvisionWorktreeInBackground(args.navigation),
        createTerminal: (selector, options) => this.createTerminal(selector, options, worktree),
        pasteDraft: (handle, draft) => this.pasteStartupDraftWhenReady(handle, draft),
        sendFollowup: (handle, followup) => this.sendStartupFollowupWhenReady(handle, followup),
        provision: (options) => this.provisionManagedWorktreeTerminals(options, worktree),
        activate: activationCallbacks.local
      }
    })
    warning = terminalWarning
    this.emitWorktreeLifecycle({
      kind: 'created',
      worktreeId: worktree.id,
      path: worktree.path,
      branch: worktree.branch
    })
    return {
      worktree: {
        ...worktree,
        parentWorktreeId: lineage?.parentWorktreeId ?? null,
        childWorktreeIds: [],
        lineage,
        workspaceLineage,
        git: created
      },
      ...(lineageInput ? { lineage, workspaceLineage, warnings: lineageWarnings } : {}),
      ...(returnedSetup ? { setup: returnedSetup } : {}),
      ...(args.awaitTerminalProvisioning
        ? {
            setupReceipt: {
              requested: effectiveDecision,
              hookFound,
              startupPolicy: setup?.waitForAgentStartup
                ? ('wait-for-setup' as const)
                : ('start-immediately' as const),
              state: !hookFound
                ? ('not_configured' as const)
                : effectiveDecision === 'skip' || !shouldRunSetup
                  ? ('skipped' as const)
                  : // Why: the in-process hook is already executing, so reporting
                    // spawn_failed would strand callers that retry on it.
                    didSpawnSetup || didStartInProcessSetupHook
                    ? ('running' as const)
                    : ('spawn_failed' as const),
              ...(setupTerminalHandle ? { terminalHandle: setupTerminalHandle } : {})
            }
          }
        : {}),
      ...(defaultTabs ? { defaultTabs } : {}),
      ...(warning ? { warning } : {}),
      ...(localCreate.baseFallback ? { baseFallback: localCreate.baseFallback } : {}),
      ...(addResult.localBaseRefRefresh
        ? { localBaseRefRefresh: addResult.localBaseRefRefresh }
        : {}),
      ...(addResult.localBaseRefUpdateSuggestion
        ? { localBaseRefUpdateSuggestion: addResult.localBaseRefUpdateSuggestion }
        : {}),
      ...(didSpawnStartup && startupTerminalHandle
        ? {
            startupTerminal: {
              spawned: true,
              handle: startupTerminalHandle,
              ...(startupTerminalTabId ? { tabId: startupTerminalTabId } : {}),
              ...(startupTerminalPaneKey ? { paneKey: startupTerminalPaneKey } : {}),
              ...(startupTerminalPtyId ? { ptyId: startupTerminalPtyId } : {}),
              surface: 'background' as const
            }
          }
        : {})
    }
  }
}
