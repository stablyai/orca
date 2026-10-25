import { revealCreatedTerminal } from './terminal-create-reveal'
import type { PaneSpawnOperation } from '../../../ipc/pty/pane/pane-spawn-operation'
import { OrcaRuntimeWithTerminalCreateDeduplication } from './terminal-create-deduplication'
import * as dependencies from '../../orca-runtime-create-terminal-dependencies'
import { createDesktopTerminal } from '../../orca-runtime-create-terminal-desktop'
import { buildRuntimeAgentTeamsLaunchPlan } from './agent-teams-launch-plan'
import { createIdempotentCallback } from '../../orca-runtime-report-pty-spawn-commit'
import { recordPtySurface, spawnSurfaceClaimSequence } from '../../pty-recorded-surface-topology'
import { agentLaunchTokenFor, withAgentLaunchToken } from '../../../agent-launch/agent-launch-token'
import { seedPtyLaunchTitle } from './pty-launch-title'
import { migratedPaneRestoreHint } from '../../migrated-pane-restore-cwd'
import { paneSize, resolvePtyFirstSize } from '../../../ipc/pty/pty-first-size'

export abstract class OrcaRuntimeWithCreateTerminal extends OrcaRuntimeWithTerminalCreateDeduplication {
  protected abstract paneStartStatusArgs: dependencies.PaneStartArgsOf

  async createTerminal(
    worktreeSelector?: string,
    opts: dependencies.TerminalCreateOptions = {},
    // Internal creation evidence; RPC and preload callers never supply it.
    created?: dependencies.Worktree
  ): Promise<dependencies.RuntimeTerminalCreate> {
    if (opts.startupAgent && worktreeSelector === undefined) {
      throw new Error(`startupAgent ${opts.startupAgent} requires a workspace selector.`)
    }
    const callerColors = dependencies.normalizeColorQueryReplyColors(opts.terminalColorQueryReplies)
    // Older paired clients report their theme only at creation.
    if (callerColors) {
      dependencies.setPairedViewerColors(callerColors)
    }
    const presentation = dependencies.resolveTerminalPresentation(opts)
    // Why: this process starts every terminal it can place, so a slow window only delays showing
    // it; a window-made create that timed out here still ran later, and a retry duplicated it.
    if (worktreeSelector !== undefined) {
      const { ptyController } = this
      if (!ptyController?.spawn) {
        throw new Error('runtime_unavailable')
      }
      const workspace = await this.resolveTerminalWorkspaceLaunchScope(worktreeSelector, created)
      const launchOpts = await this.resolveAgentTerminalCreateOptions(workspace, opts)
      const launchTitleAt = { sequence: this.nextTitleObservationSequence(), epochMs: Date.now() }
      let cwd = this.resolveWorkspaceTerminalStartupCwd(workspace, launchOpts.cwd) ?? workspace.path
      const session = this.getWorkspaceSessionForWorktree(workspace.id)
      // The window's latest published active group is where its reveal places the tab.
      const groupId =
        launchOpts.targetGroupId ??
        this.mobileSessionTabsByWorktree.get(workspace.id)?.activeGroupId ??
        session?.activeGroupIdByWorktree?.[workspace.id]
      // A workspace not shown since launch has no measured group; with at most one group, its tab
      // opens in a lone group, which every workspace sizes alike.
      const singleGroup =
        (session?.tabGroups?.[workspace.id]?.length ?? 0) <= 1
          ? this.singleGroupWorkspaceGridSize
          : undefined
      const group = groupId ? this.terminalGroupGridSizes?.[groupId] : undefined
      const initialSize = resolvePtyFirstSize({ pane: paneSize(session, opts), group, singleGroup })
      let preAllocatedHandle =
        launchOpts.preAllocatedHandle ?? this.createPreAllocatedTerminalHandle()
      let { tabId, leafId, paneKey } = dependencies.allocateTerminalPaneIdentity(launchOpts)
      const restoreHint = migratedPaneRestoreHint(this.store, workspace, paneKey)
      const reportPtySpawnCommitted = createIdempotentCallback(
        restoreHint.consumeThen(launchOpts.onPtySpawnCommitted)
      )
      // Claimed before any await, so a concurrent create of this pane cannot slip in between.
      const claimedStablePaneCreate = ptyController.claimStablePaneCreate?.({
        worktreeId: workspace.id,
        connectionId: workspace.connectionId,
        tabId,
        leafId
      })
      const releaseStablePaneCreate = createIdempotentCallback(claimedStablePaneCreate)
      const launchToken = agentLaunchTokenFor(launchOpts, dependencies.randomUUID)
      let effectiveLaunchConfig = launchOpts.launchConfig
      let result!: Awaited<ReturnType<NonNullable<dependencies.RuntimePtyController['spawn']>>>
      const spawnFresh = async (operation: PaneSpawnOperation) => {
        const baseEnv = withAgentLaunchToken(launchOpts.env, launchToken)
        let agentTeamsPlan: Awaited<ReturnType<typeof buildRuntimeAgentTeamsLaunchPlan>>['plan']
        let sequencedStartupCommand: string | undefined
        try {
          const agentTeams = await buildRuntimeAgentTeamsLaunchPlan({
            launchConfig: launchOpts.launchConfig,
            command: launchOpts.command,
            claudeAgentTeamsSourceCommand: launchOpts.claudeAgentTeamsSourceCommand,
            claudeAgentTeamsMode: this.store?.getSettings?.().claudeAgentTeamsMode,
            baseEnv: { ...process.env, ...baseEnv },
            adoptedBeforeLaunch: null,
            createTeamEnv: (shimDir, shimBin) =>
              this.claudeAgentTeams.createLaunchEnv({
                leaderHandle: preAllocatedHandle,
                baseEnv: { ...process.env, ...baseEnv },
                shimDir,
                shimBin
              }).env
          })
          agentTeamsPlan = agentTeams.plan
          sequencedStartupCommand = agentTeams.sequencedStartupCommand
          effectiveLaunchConfig = agentTeams.effectiveLaunchConfig
        } catch (error) {
          releaseStablePaneCreate?.()
          throw error
        }
        const env = this.buildTerminalWorkspaceEnv(
          workspace,
          {
            ...baseEnv,
            ...(sequencedStartupCommand
              ? {
                  [dependencies.SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: sequencedStartupCommand
                }
              : {})
          },
          agentTeamsPlan?.env
        )
        const terminalColorQueryReplies = dependencies.getTerminalViewerColors()
        if (launchOpts.signal?.aborted) {
          throw new Error('client_disconnected')
        }
        try {
          const { launchAgent } = launchOpts
          launchOpts.onPtySpawnDispatched?.({ launchConfig: effectiveLaunchConfig, launchAgent })
          result = await dependencies.spawnInAdmittedPane(this.store, ptyController, {
            ...initialSize,
            cwd,
            command: sequencedStartupCommand
              ? launchOpts.command
              : (agentTeamsPlan?.command ?? launchOpts.command),
            launchAgent: launchOpts.launchAgent,
            commandDelivery: 'provider',
            startupCommandDelivery: launchOpts.startupCommandDelivery,
            env,
            envToDelete: dependencies.mergeTerminalEnvDeletionKeys(
              launchOpts.envToDelete,
              agentTeamsPlan?.envToDelete
            ),
            resumeProviderSession: launchOpts.resumeProviderSession,
            telemetry: launchOpts.telemetry,
            connectionId: workspace.connectionId,
            worktreeId: workspace.id,
            preAllocatedHandle,
            tabId,
            leafId,
            ...dependencies.spawnShellInputs(launchOpts),
            ...(terminalColorQueryReplies ? { terminalColorQueryReplies } : {}),
            terminalKittyKeyboardProtocol: launchOpts.terminalKittyKeyboardProtocol,
            ...(launchOpts.agentSessionClaim
              ? {
                  agentSessionEnsure: {
                    claim: launchOpts.agentSessionClaim,
                    surface: {
                      worktreeId: workspace.id,
                      tabId,
                      leafId,
                      terminalHandle: preAllocatedHandle
                    }
                  }
                }
              : {}),
            ...(launchOpts.agentSessionCreateOperationId
              ? {
                  agentSessionCreateOperationId: launchOpts.agentSessionCreateOperationId
                }
              : {}),
            ...dependencies.callerSpawnScope(launchOpts),
            ...(launchOpts.onPtySpawnCommitted
              ? { onPtySpawnCommitted: reportPtySpawnCommitted }
              : {}),
            paneSpawnOperation: operation,
            ...dependencies.newTabIn(launchOpts),
            ...(launchOpts.afterTabId ? { afterTabId: launchOpts.afterTabId } : {}),
            ...(launchOpts.sessionId ? { sessionId: launchOpts.sessionId } : {}),
            ...(launchOpts.isNewSession ? { isNewSession: true } : {}),
            ...dependencies.BACKGROUND_TERMINAL_SPAWN_FLAGS,
            ...this.paneStartStatusArgs(launchOpts)
          })
        } finally {
          releaseStablePaneCreate?.()
        }
        return result
      }
      try {
        // A pane moved from another host reopens where it last was, until a spawn commits.
        cwd = (await restoreHint.peekCwd(launchOpts.cwd)) ?? cwd
        if (launchOpts.signal?.aborted) {
          throw new Error('client_disconnected')
        }
        const adoptedBeforeLaunch = await ptyController.adoptStablePane?.({
          ...initialSize,
          cwd,
          connectionId: workspace.connectionId,
          worktreeId: workspace.id,
          preAllocatedHandle,
          tabId,
          leafId,
          spawnFresh,
          signal: launchOpts.signal
        })
        if (adoptedBeforeLaunch) {
          result = dependencies.materializedStablePaneReply(adoptedBeforeLaunch, preAllocatedHandle)
        } else if (!ptyController.adoptStablePane) {
          result = await spawnFresh({ mustExist: false })
        }
        if (!result.stablePaneOwner) {
          reportPtySpawnCommitted()
        }
        restoreHint.consume()
        const savedStartupCwd = result.savedStartupCwd ?? cwd
        // Why here: refused before a handle, snapshot or reveal could pose the live PTY as new.
        const adoptedStablePane = dependencies.admitStablePaneAdoption(result, launchOpts)
        if (result.agentSessionEnsure) {
          const canonicalSurface = result.agentSessionEnsure.owner.surface
          preAllocatedHandle = canonicalSurface.terminalHandle
          tabId = canonicalSurface.tabId
          leafId = canonicalSurface.leafId
          paneKey = dependencies.makePaneKey(tabId, leafId)
        } else if (result.stablePaneOwner) {
          preAllocatedHandle = result.stablePaneOwner.handle
          tabId = result.stablePaneOwner.tabId
          leafId = result.stablePaneOwner.leafId
          paneKey = dependencies.makePaneKey(tabId, leafId)
        }
        try {
          this.assertPtyDidNotExitBeforeRegistration(result.id, result.incarnationId)
        } catch (error) {
          if (error instanceof Error && error.message === 'agent_session_exited_during_start') {
            this.releaseRejectedPtyRegistrationFence(result.id, result.incarnationId)
          }
          throw error
        }
        if (!adoptedStablePane) {
          this.registerPreAllocatedHandleForPty(result.id, preAllocatedHandle)
          if (result.wslDistro) {
            this.preparePtyExecutionContext(result.id, result.wslDistro)
          }
          this.registerPty(result.id, workspace.id, workspace.connectionId, {
            tabId,
            leafId,
            terminalHandle: preAllocatedHandle,
            ...(result.incarnationId ? { incarnationId: result.incarnationId } : {})
          })
        }
        const pty = this.getOrCreatePtyWorktreeRecord(result.id)
        if (pty) {
          pty.runtimeSessionOwned = true
          if (!adoptedStablePane) {
            seedPtyLaunchTitle(pty, launchOpts.title, launchTitleAt, (title, at) =>
              this.setPtyManagementTitleFromObservedTitle(pty, title, at)
            )
            pty.launchConfig = effectiveLaunchConfig
              ? dependencies.copySleepingAgentLaunchConfig(effectiveLaunchConfig)
              : null
            pty.launchToken = launchToken ?? null
            pty.launchIncarnationId = launchToken ? pty.incarnationId : null
            pty.launchAgent = launchOpts.launchAgent ?? null
          }
          recordPtySurface(pty, tabId, paneKey, spawnSurfaceClaimSequence(this.graphSequence))
        }
        const handle = pty ? this.issuePtyHandle(pty) : preAllocatedHandle
        if (pty && !adoptedStablePane && launchOpts.deferMobileSessionPublish !== true) {
          this.publishPtyBackedMobileSessionTerminal(workspace.id, pty, {
            tabId,
            leafId,
            title: launchOpts.title ?? null,
            activate: presentation === 'focused',
            selectIfNoActiveTab: presentation !== 'background',
            ...(launchOpts.viewMode ? { viewMode: launchOpts.viewMode } : {}),
            ...(savedStartupCwd !== workspace.path ? { startupCwd: savedStartupCwd } : {})
          })
        }
        const reveal = revealCreatedTerminal({
          notifier: this.notifier,
          workspace,
          ptyId: result.id,
          handle,
          cwd: savedStartupCwd,
          launchOpts,
          effectiveLaunchConfig,
          launchToken,
          presentation,
          opts,
          tabId,
          leafId
        })
        const { surface, warning } = reveal instanceof Promise ? await reveal : reveal
        const agentSessionDisposition = result.agentSessionEnsure?.disposition
        return {
          handle,
          savedStartupCwd,
          tabId,
          paneKey,
          ptyId: result.id,
          worktreeId: workspace.id,
          title: pty?.title ?? launchOpts.title ?? null,
          ...this.getPtyExecutionHostMetadata(result.id),
          surface,
          ...(result.pid ? { processId: result.pid } : {}),
          ...(result.agentSessionEnsure ? { agentSessionDisposition } : {}),
          ...(adoptedStablePane ? { isReattach: true as const } : {}),
          ...(result.startupCwdFallback ? { startupCwdFallback: result.startupCwdFallback } : {}),
          ...(warning ? { warning } : {})
        }
      } finally {
        releaseStablePaneCreate()
      }
    }
    // The renderer owns this spawn, so this process cannot see when it is requested.
    opts.onPtySpawnDispatched?.()
    return createDesktopTerminal(this, opts, presentation)
  }
}
