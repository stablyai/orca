import { OrcaRuntimeWithTerminalCreateDeduplication } from './terminal-create-deduplication'
import * as dependencies from '../../orca-runtime-create-terminal-dependencies'
import { createDesktopTerminal } from '../../orca-runtime-create-terminal-desktop'
import { buildRuntimeAgentTeamsLaunchPlan } from './agent-teams-launch-plan'
import { createIdempotentCallback } from '../../orca-runtime-report-pty-spawn-commit'
import { recordPtySurface, spawnSurfaceClaimSequence } from '../../pty-recorded-surface-topology'
import { agentLaunchTokenFor } from '../../../agent-launch/agent-launch-token'
import { migratedPaneRestoreHint } from '../../migrated-pane-restore-cwd'

export abstract class OrcaRuntimeWithCreateTerminal extends OrcaRuntimeWithTerminalCreateDeduplication {
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
      if (!this.ptyController?.spawn) {
        throw new Error('runtime_unavailable')
      }
      const workspace = await this.resolveTerminalWorkspaceLaunchScope(worktreeSelector, created)
      const launchOpts = await this.resolveAgentTerminalCreateOptions(workspace, opts)
      let cwd = this.resolveWorkspaceTerminalStartupCwd(workspace, launchOpts.cwd) ?? workspace.path
      const session = this.getWorkspaceSessionForWorktree(workspace.id)
      // The window's latest published active group is where its reveal places the tab.
      const groupId =
        launchOpts.targetGroupId ??
        this.mobileSessionTabsByWorktree.get(workspace.id)?.activeGroupId ??
        session?.activeGroupIdByWorktree?.[workspace.id]
      // A workspace not shown since launch has no measured group; with at most one group, its tab
      // opens in a lone group, which every workspace sizes alike.
      const singleGroupSize =
        (session?.tabGroups?.[workspace.id]?.length ?? 0) <= 1
          ? this.singleGroupWorkspaceGridSize
          : undefined
      // Why 120x40: no window measured the group the tab opens in: none attached (serve, orcad), a
      // multi-group workspace not shown since launch, or no pane at the default font mounted yet.
      // #1707's original size.
      const initialSize = (groupId && this.terminalGroupGridSizes?.[groupId]) ||
        singleGroupSize || { cols: 120, rows: 40 }
      let preAllocatedHandle =
        launchOpts.preAllocatedHandle ?? this.createPreAllocatedTerminalHandle()
      let { tabId, leafId, paneKey } = dependencies.allocateTerminalPaneIdentity(launchOpts)
      const restoreHint = migratedPaneRestoreHint(this.store, workspace, paneKey)
      const reportPtySpawnCommitted = createIdempotentCallback(
        restoreHint.consumeThen(launchOpts.onPtySpawnCommitted)
      )
      // Claimed before any await, so a concurrent create of this pane cannot slip in between.
      const claimedStablePaneCreate = this.ptyController.claimStablePaneCreate?.({
        worktreeId: workspace.id,
        connectionId: workspace.connectionId,
        tabId,
        leafId
      })
      const releaseStablePaneCreate = createIdempotentCallback(claimedStablePaneCreate)
      try {
        // A pane moved from another host reopens where it last was, until a spawn commits.
        cwd = (await restoreHint.peekCwd(launchOpts.cwd)) ?? cwd
        if (launchOpts.signal?.aborted) {
          throw new Error('client_disconnected')
        }
        const adoptedBeforeLaunch = await this.ptyController.adoptStablePane?.({
          ...initialSize,
          cwd,
          connectionId: workspace.connectionId,
          worktreeId: workspace.id,
          preAllocatedHandle,
          tabId,
          leafId
        })
        const launchToken = agentLaunchTokenFor(launchOpts, dependencies.randomUUID)
        const baseEnv = {
          ...launchOpts.env,
          ...(launchToken ? { ORCA_AGENT_LAUNCH_TOKEN: launchToken } : {})
        }
        let agentTeamsPlan: Awaited<ReturnType<typeof buildRuntimeAgentTeamsLaunchPlan>>['plan']
        let sequencedStartupCommand: string | undefined
        let effectiveLaunchConfig = launchOpts.launchConfig
        try {
          const agentTeams = await buildRuntimeAgentTeamsLaunchPlan({
            launchConfig: launchOpts.launchConfig,
            command: launchOpts.command,
            claudeAgentTeamsSourceCommand: launchOpts.claudeAgentTeamsSourceCommand,
            claudeAgentTeamsMode: this.store?.getSettings?.().claudeAgentTeamsMode,
            baseEnv: { ...process.env, ...baseEnv },
            adoptedBeforeLaunch,
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
        let result: Awaited<ReturnType<NonNullable<dependencies.RuntimePtyController['spawn']>>>
        try {
          const { launchAgent } = launchOpts
          launchOpts.onPtySpawnDispatched?.({
            launchConfig: effectiveLaunchConfig,
            launchAgent
          })
          result = await dependencies.spawnInAdmittedPane(this.store, this.ptyController, {
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
            ...(adoptedBeforeLaunch ? { adoptedStablePane: adoptedBeforeLaunch } : {}),
            ...dependencies.newTabIn(launchOpts),
            ...(launchOpts.afterTabId ? { afterTabId: launchOpts.afterTabId } : {}),
            ...(launchOpts.sessionId ? { sessionId: launchOpts.sessionId } : {}),
            ...(!adoptedBeforeLaunch && launchOpts.isNewSession ? { isNewSession: true } : {}),
            ...dependencies.BACKGROUND_TERMINAL_SPAWN_FLAGS
          })
        } finally {
          releaseStablePaneCreate?.()
        }
        if (!result.stablePaneOwner) {
          reportPtySpawnCommitted()
        }
        restoreHint.consume()
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
        const pty = this.getOrCreatePtyWorktreeRecord(result.id)
        if (pty) {
          pty.runtimeSessionOwned = true
          if (!adoptedStablePane) {
            if (launchOpts.title) {
              const observedAt = this.nextTitleObservationSequence()
              pty.title = launchOpts.title
              pty.titleUpdatedAt = observedAt
              this.setPtyManagementTitleFromObservedTitle(pty, launchOpts.title, observedAt)
            } else {
              pty.title = null
              pty.titleUpdatedAt = null
            }
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
            ...(cwd !== workspace.path ? { startupCwd: cwd } : {})
          })
        }
        let surface: dependencies.RuntimeTerminalCreate['surface'] = 'background'
        let warning: string | undefined
        if (presentation !== 'background' && this.notifier?.revealTerminalSession) {
          try {
            await this.notifier.revealTerminalSession(workspace.id, {
              ptyId: result.id,
              title: launchOpts.title ?? null,
              ...(cwd !== workspace.path ? { cwd } : {}),
              ...(effectiveLaunchConfig ? { launchConfig: effectiveLaunchConfig } : {}),
              ...(launchToken ? { launchToken } : {}),
              ...(launchOpts.launchAgent ? { launchAgent: launchOpts.launchAgent } : {}),
              ...(launchOpts.viewMode ? { viewMode: launchOpts.viewMode } : {}),
              activate: presentation === 'focused',
              ...(presentation ? { presentation } : {}),
              ...dependencies.terminalRevealViewerOptions(opts),
              tabId,
              leafId
            })
            surface = 'visible'
          } catch (err) {
            console.warn(`[terminal-create] failed to create inactive tab for ${result.id}:`, err)
            warning = dependencies.createTerminalRevealWarning(handle, err)
          }
        } else if (presentation !== 'background') {
          warning = dependencies.createTerminalRevealWarning(handle)
        }
        return {
          handle,
          tabId,
          paneKey,
          ptyId: result.id,
          worktreeId: workspace.id,
          title: pty?.title ?? launchOpts.title ?? null,
          ...this.getPtyExecutionHostMetadata(result.id),
          surface,
          ...(result.pid ? { processId: result.pid } : {}),
          ...(result.agentSessionEnsure
            ? { agentSessionDisposition: result.agentSessionEnsure.disposition }
            : {}),
          ...(adoptedStablePane ? { isReattach: true as const } : {}),
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
