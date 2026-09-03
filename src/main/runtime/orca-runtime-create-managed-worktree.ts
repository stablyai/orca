// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithGetWorktreeTerminalProvisioningHost } from './orca-runtime-get-worktree-terminal-provisioning-host'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import { isFolderRepo } from '../../shared/repo-kind'
import { getRepoSshConnectionId } from '../../shared/execution-host'
import { createRuntimeFolderWorktree } from './runtime-folder-worktree-create'
import { createRuntimeLocalManagedWorktree } from './runtime-local-worktree-create'
import { prepareRuntimeLocalWorktreeSetup } from './runtime-local-worktree-setup'
import { invalidateAuthorizedRootsCache } from '../ipc/filesystem-auth'
import { startRuntimeLocalWorktreeTerminals } from './runtime-local-worktree-terminal-startup'

export class OrcaRuntimeWithCreateManagedWorktree extends OrcaRuntimeWithGetWorktreeTerminalProvisioningHost {
  async createManagedWorktree(
    args: RuntimeManagedWorktreeCreateArgs
  ): Promise<CreateWorktreeResult> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }

    const repo = await this.resolveRepoSelector(args.repoSelector)
    const createSettings = this.store.getSettings()
    const requestedAgent = args.startupAgent ?? args.createdWithAgent
    const requestedAgentEnabled =
      requestedAgent !== undefined
        ? isTuiAgentEnabled(requestedAgent, createSettings.disabledTuiAgents)
        : false
    if ((args.startup || args.startupAgent) && requestedAgent && !requestedAgentEnabled) {
      throw new Error('Selected agent is disabled. Choose an enabled agent before creating.')
    }
    if (
      args.startup &&
      args.startupDraftPaste &&
      !isTuiAgentEnabled(args.startupDraftPaste.agent, createSettings.disabledTuiAgents)
    ) {
      throw new Error('Selected agent is disabled. Choose an enabled agent before creating.')
    }
    const agentStartup =
      !args.startup && args.startupAgent
        ? this.buildStartupForAgent(
            repo,
            args.startupAgent,
            args.startupPrompt,
            args.startupLaunchPreferences
          )
        : null
    const draftStartup =
      !args.startup && !agentStartup && args.startupDraft
        ? await this.buildStartupForDraft(repo, args.startupDraft, requestedAgent)
        : null
    const effectiveStartup = args.startup ?? agentStartup?.startup ?? draftStartup?.startup
    const effectiveStartupFollowup = agentStartup?.followup
    const effectiveCreatedWithAgent = args.startup
      ? args.createdWithAgent
      : (agentStartup?.agent ??
        draftStartup?.agent ??
        (requestedAgentEnabled ? requestedAgent : undefined))
    const effectiveDraftPaste = args.startupDraftPaste ?? draftStartup?.draftPaste
    // Resolve the execution host once: SSH ownership has two spellings, and reading the raw
    // `connectionId` field routes an `executionHostId: 'ssh:*'`-only repo down the local path,
    // which runs `git worktree add` on the client against a remote path.
    const sshConnectionId = getRepoSshConnectionId(repo)
    if (isFolderRepo(repo)) {
      // A folder workspace is a registration, not a filesystem create, so it is host-agnostic —
      // except for the agent trust write, which must land on the host that will run the agent.
      return createRuntimeFolderWorktree({
        request: args,
        repo,
        startup: effectiveStartup,
        startupFollowup: effectiveStartupFollowup,
        createdWithAgent: effectiveCreatedWithAgent,
        draftPaste: effectiveDraftPaste,
        deps: {
          store: this.store,
          ptySpawnAvailable: Boolean(this.ptyController?.spawn),
          createTerminal: (selector, options) => this.createTerminal(selector, options),
          markTrusted: (agent, path) =>
            this.markWorkspaceTrustedForAgent(agent, sshConnectionId, path),
          pasteDraft: (handle, draft) => this.pasteStartupDraftWhenReady(handle, draft),
          sendFollowup: (handle, followup) => this.sendStartupFollowupWhenReady(handle, followup),
          invalidateResolvedWorktrees: () => this.invalidateResolvedWorktreeCache(),
          notifyWorktreesChanged: (repoId) => this.notifyWorktreesChanged(repoId),
          emitCreated: (event) => this.emitWorktreeLifecycle(event),
          activate: (repoId, worktreeId, setup, startup) =>
            this.notifyActivateWorktree(
              repoId,
              worktreeId,
              setup,
              startup,
              undefined,
              args.navigation
            )
        }
      })
    }
    const lineageInput =
      args.lineage || args.comment ? { ...args.lineage, comment: args.comment } : undefined
    const lineageResolution = await this.resolveLineageForWorktreeCreate(lineageInput)
    if (sshConnectionId) {
      // Why normalize the row: the remote-create pipeline reads `repo.connectionId!` at every
      // depth, so hand it the connection the resolved host actually names.
      const result = await this.createManagedRemoteWorktree(
        { ...repo, connectionId: sshConnectionId },
        {
          ...args,
          activate: args.activate,
          ...(effectiveStartup ? { startup: effectiveStartup } : {}),
          ...(effectiveStartupFollowup ? { startupFollowup: effectiveStartupFollowup } : {}),
          ...(effectiveCreatedWithAgent ? { createdWithAgent: effectiveCreatedWithAgent } : {}),
          ...(effectiveDraftPaste ? { startupDraftPaste: effectiveDraftPaste } : {})
        }
      )
      const recordedLineage = this.recordCreatedWorktreeLineage(result.worktree, lineageResolution)
      this.emitWorktreeLifecycle({
        kind: 'created',
        worktreeId: result.worktree.id,
        path: result.worktree.path,
        branch: result.worktree.branch
      })
      return {
        ...result,
        worktree: {
          ...result.worktree,
          parentWorktreeId: recordedLineage.lineage?.parentWorktreeId ?? null,
          childWorktreeIds: result.worktree.childWorktreeIds ?? [],
          lineage: recordedLineage.lineage,
          workspaceLineage: recordedLineage.workspaceLineage
        },
        ...(lineageInput
          ? {
              lineage: recordedLineage.lineage,
              workspaceLineage: recordedLineage.workspaceLineage,
              warnings: recordedLineage.warnings
            }
          : {})
      }
    }
    const { worktree, worktreePath, includeCopyWarning, created, addResult, metadataResult } =
      await createRuntimeLocalManagedWorktree({
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
        onWorktreeMetadataPersisted: (persistedWorktree) =>
          this.recordCreatedWorktreeLineage(persistedWorktree, lineageResolution)
      })
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
    invalidateAuthorizedRootsCache()

    this.notifyWorktreesChanged(repo.id)
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
      createdWithAgent: effectiveCreatedWithAgent,
      draftPaste: effectiveDraftPaste,
      warning,
      ports: {
        canSpawn: Boolean(this.ptyController?.spawn),
        markTrusted: (agent, path) => this.markLocalWorkspaceTrustedForAgent(agent, path),
        createTerminal: (selector, options) => this.createTerminal(selector, options),
        pasteDraft: (handle, draft) => this.pasteStartupDraftWhenReady(handle, draft),
        sendFollowup: (handle, followup) => this.sendStartupFollowupWhenReady(handle, followup),
        provision: (options) => this.provisionManagedWorktreeTerminals(options),
        activate: (repoId, worktreeId, activationSetup, startup, activationDefaultTabs) =>
          this.notifyActivateWorktree(
            repoId,
            worktreeId,
            activationSetup,
            startup,
            activationDefaultTabs,
            args.navigation
          )
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
