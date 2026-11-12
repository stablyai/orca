import { assertOpenCodeModelLaunchPreferencesAbsent } from '../../../opencode/model-launch/opencode-model-startup-plan'
import {
  formatAmbiguousCwdParentMessage,
  type WorktreeLineageInput,
  type WorktreeLineageResolution
} from '../lineage/runtime-worktree-lineage-resolution'
import { RuntimeLineageError, LINEAGE_PARENT_AMBIGUOUS } from '../lineage/runtime-lineage-error'
import type { Repo } from '../../../../shared/repo-types'
import { OrcaRuntimeWithGetWorktreeTerminalProvisioningHost } from '../startup/workspace-terminal-provisioning'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import type { CreateWorktreeResult } from '../../../../shared/worktree/create-types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { notifyLineageRepos } from '../../../workspaces/catalog/worktree-lineage-change-notification'
import { resolveWorktreeCreateRoute } from '../../../workspaces/creation/worktree-create-execution-host-route'
import { ExecutionHostNotDispatchableError } from '../../../providers/execution-host-provider-dispatch'
import { SshHostNotServedError } from '../../../providers/ssh-host-not-served-error'
import { createRuntimeFolderWorktree } from './runtime-folder-worktree-create'
import type { RuntimeNavigationTarget } from '../../../../shared/runtime-navigation'
import type { Worktree } from '../../../../shared/worktree/types'
import { createRuntimeLocalManagedWorktree } from './runtime-local-worktree-create'
import type { PreparationRearmHolder } from '../../../workspaces/creation/preparation/worktree-create-preparation'
import {
  buildRuntimeSetupReceipt,
  prepareRuntimeLocalWorktreeSetup
} from './runtime-local-worktree-setup'
import { invalidateAuthorizedRootsCacheForRepo } from '../../../ipc/worktrees/removal/registered-worktree-roots-scoped-invalidation'
import { startRuntimeLocalWorktreeTerminals } from '../startup/runtime-local-worktree-terminal-startup'
import type { RuntimeLocalWorktreeTerminalPorts } from '../startup/runtime-local-worktree-terminal-startup'
import { trackRuntimeWorkspaceCreate } from '../../../workspaces/creation/workspace-create-telemetry'
import { baseDriftWarningResult } from '../../../git/worktrees/creation/worktree-base-drift-warning'
import type { RuntimeWorkspaceCreateEvents } from '../../../workspaces/creation/workspace-create-telemetry'

import {
  createdWorkspaceActivationCallbacks,
  wslUserAct
} from '../startup/workspace-create-activation'
import { assertWslMoveRepoWritable } from '../../../persistence/moving-wsl-projects/quiescence/wsl-move-scope-guard'
import { resolveManagedWorktreeCreateStartup } from '../startup/managed-worktree-create-startup'
import type { WorkspaceCreationHandle } from '../lifecycle/workspace-lifecycle-creations'
import { workspaceLifecycleKey } from '../lifecycle/workspace-lifecycle-commands'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { applyWorkspaceCreatePluginHook } from '../../../plugins/hooks/workspace-create-plugin-hook'
import { withProjectWorktreeCreate } from '../../../workspaces/creation/worktree-create-in-flight'

export abstract class OrcaRuntimeWithCreateManagedWorktree extends OrcaRuntimeWithGetWorktreeTerminalProvisioningHost {
  abstract resolveLineageForWorktreeCreate(
    input?: WorktreeLineageInput,
    childRepo?: Repo
  ): Promise<WorktreeLineageResolution>

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
    this.requireStore()

    assertOpenCodeModelLaunchPreferencesAbsent(
      args.startup ? (args.startupAgent ?? args.createdWithAgent) : undefined,
      args.startupSessionOptions ?? args.startupLaunchPreferences
    )

    const repo = await this.resolveRepoSelector(args.repoSelector)
    return withProjectWorktreeCreate(repo, async () => {
      const request = await applyWorkspaceCreatePluginHook(args, repo)
      // Listed from here: a create refused before its project resolved has nothing to show.
      const creation = this.workspaceLifecycle?.openCreate({
        creationId: request.creationId,
        repoId: repo.id,
        keyOf: (worktreeId) => workspaceLifecycleKey(getRepoExecutionHostId(repo), worktreeId)
      })
      return this.createInResolvedProject(request, repo, creation, rearm, events).finally(() =>
        creation?.close()
      )
    })
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
          terminals: this.localWorktreeTerminalPorts(args, activationCallbacks.local),
          invalidateResolvedWorktrees: () => this.invalidateResolvedWorktreeCache(),
          notifyWorktreesChanged: (repoId) => this.notifyWorktreesChanged(repoId),
          emitCreated: (event) => this.emitWorktreeLifecycle(event),
          activate: activationCallbacks.folder,
          setup: {
            runtimeTarget: () => this.getLocalGitExecutionOptionArgs(repo)[0],
            shouldUseSetupRunner: this.canUseSetupRunner(effectiveStartup)
          }
        }
      })
    }
    const lineageInput =
      args.lineage || args.comment ? { ...args.lineage, comment: args.comment } : undefined
    const lineageResolution = await this.resolveLineageForWorktreeCreate(lineageInput, repo).catch(
      (error: unknown) => {
        if (error instanceof RuntimeLineageError && error.code === LINEAGE_PARENT_AMBIGUOUS) {
          throw new RuntimeLineageError(
            error.code,
            formatAmbiguousCwdParentMessage(args.startupAgent ?? args.createdWithAgent)
          )
        }
        throw error
      }
    )
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
    const { lineage, workspaceLineage } = metadataResult

    const preparedSetup = await prepareRuntimeLocalWorktreeSetup({
      request: args,
      repo,
      worktreePath,
      settings: createSettings,
      runtimeTarget: this.getLocalGitExecutionOptionArgs(repo)[0],
      shouldUseSetupRunner: this.canUseSetupRunner(effectiveStartup),
      warning:
        [includeCopyWarning, addResult.upstreamWarning].filter(Boolean).join(' ') || undefined
    })
    const { setup, defaultTabs, setupTrustMismatch } = preparedSetup
    const { warning } = preparedSetup

    this.invalidateResolvedWorktreeCache()
    this.invalidateWorktreeScanCacheForRepo(repo.id)
    // Invalidate this repo's authorized-root cache so CLI creates work; global invalidation needlessly rescans every repo.
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
      ports: this.localWorktreeTerminalPorts(args, activationCallbacks.local, worktree)
    })
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
      ...(lineageInput ? metadataResult : {}),
      ...(returnedSetup ? { setup: returnedSetup } : {}),
      ...(args.awaitTerminalProvisioning
        ? {
            setupReceipt: buildRuntimeSetupReceipt(
              preparedSetup,
              didSpawnSetup,
              setupTerminalHandle
            )
          }
        : {}),
      ...(defaultTabs ? { defaultTabs } : {}),
      ...(setupTrustMismatch ? { setupTrustMismatch } : {}),
      ...baseDriftWarningResult(localCreate.localBaseRefDriftWarning, terminalWarning),
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

  // A window, an agent or a PTY host can show setup in a terminal; otherwise it runs in-process.
  private canUseSetupRunner(startup: unknown): boolean {
    return (
      this.authoritativeWindowId !== null || Boolean(startup) || Boolean(this.ptyController?.spawn)
    )
  }

  private localWorktreeTerminalPorts(
    args: { navigation?: RuntimeNavigationTarget; wslUserAct?: true },
    activate: RuntimeLocalWorktreeTerminalPorts['activate'],
    worktree?: Worktree
  ): RuntimeLocalWorktreeTerminalPorts {
    return {
      canSpawn: Boolean(this.ptyController?.spawn),
      provisionInBackground: () => this.shouldProvisionWorktreeInBackground(args.navigation),
      createTerminal: (selector, options) =>
        worktree
          ? this.createTerminal(selector, { ...options, ...wslUserAct(args) }, worktree)
          : this.createTerminal(selector, { ...options, ...wslUserAct(args) }),
      pasteDraft: (handle, draft) => this.pasteStartupDraftWhenReady(handle, draft),
      sendFollowup: (handle, followup, terminal) =>
        void this.deliverStartupFollowup(handle, followup, { terminalCreation: terminal }),
      provision: (options) =>
        this.provisionManagedWorktreeTerminals({ ...options, ...wslUserAct(args) }, worktree),
      activate
    }
  }
}
