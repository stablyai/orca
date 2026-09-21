// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithTerminalCreateDeduplication } from './orca-runtime-terminal-create-deduplication'
import * as dependencies from './orca-runtime-create-terminal-dependencies'
import { createDesktopTerminal } from './orca-runtime-create-terminal-desktop'
import { buildRuntimeAgentTeamsLaunchPlan } from './orca-runtime-agent-teams-launch-plan'
import { createPtySpawnCommitReporter } from './orca-runtime-report-pty-spawn-commit'

export class OrcaRuntimeWithCreateTerminal extends OrcaRuntimeWithTerminalCreateDeduplication {
  async createTerminal(
    worktreeSelector?: string,
    opts: dependencies.TerminalCreateOptions = {}
  ): Promise<dependencies.RuntimeTerminalCreate> {
    if (opts.startupAgent && worktreeSelector === undefined) {
      throw new Error(`startupAgent ${opts.startupAgent} requires a workspace selector.`)
    }
    const presentation = dependencies.resolveTerminalPresentation(opts)
    const requiresRendererFocus = opts.presentation === 'focused' || opts.focus === true
    const availableAuthoritativeWindow = this.getAvailableAuthoritativeWindow()
    const rendererWindow = opts.rendererBacked === true ? availableAuthoritativeWindow : null
    const shouldCreateInBackground =
      worktreeSelector !== undefined &&
      (Boolean(opts.agentSessionClaim) ||
        (!requiresRendererFocus && opts.rendererBacked !== true) ||
        availableAuthoritativeWindow === null)
    if (shouldCreateInBackground) {
      if (!this.ptyController?.spawn) {
        throw new Error('runtime_unavailable')
      }
      const workspace = await this.resolveTerminalWorkspaceLaunchScope(worktreeSelector)
      const launchOpts = await this.resolveAgentTerminalCreateOptions(workspace, opts)
      const reportPtySpawnCommitted = createPtySpawnCommitReporter(launchOpts.onPtySpawnCommitted)
      const cwd =
        this.resolveWorkspaceTerminalStartupCwd(workspace, launchOpts.cwd) ?? workspace.path
      let preAllocatedHandle =
        launchOpts.preAllocatedHandle ?? this.createPreAllocatedTerminalHandle()
      const hintedTabId = launchOpts.tabId?.trim()
      const canAdoptPaneIdentity =
        hintedTabId !== undefined &&
        dependencies.isValidHostTerminalTabId(hintedTabId) &&
        launchOpts.leafId !== undefined &&
        dependencies.isTerminalLeafId(launchOpts.leafId)
      let tabId = canAdoptPaneIdentity ? (hintedTabId as string) : dependencies.randomUUID()
      let leafId = canAdoptPaneIdentity ? (launchOpts.leafId as string) : dependencies.randomUUID()
      let paneKey = dependencies.makePaneKey(tabId, leafId)
      const claimedStablePaneCreate = this.ptyController.claimStablePaneCreate?.({
        worktreeId: workspace.id,
        connectionId: workspace.connectionId,
        tabId,
        leafId
      })
      let stablePaneCreateReleased = false
      const releaseStablePaneCreate = (): void => {
        if (stablePaneCreateReleased) {
          return
        }
        stablePaneCreateReleased = true
        claimedStablePaneCreate?.()
      }
      try {
        if (launchOpts.signal?.aborted) {
          throw new Error('client_disconnected')
        }
        const adoptedBeforeLaunch = await this.ptyController.adoptStablePane?.({
          cols: 120,
          rows: 40,
          cwd,
          connectionId: workspace.connectionId,
          worktreeId: workspace.id,
          preAllocatedHandle,
          tabId,
          leafId
        })
        const launchToken = launchOpts.launchConfig
          ? (launchOpts.launchToken ?? dependencies.randomUUID())
          : undefined
        const baseEnv = {
          ...launchOpts.env,
          ...(launchToken ? { ORCA_AGENT_LAUNCH_TOKEN: launchToken } : {})
        }
        const claudeAgentTeamsMode = this.store?.getSettings?.().claudeAgentTeamsMode
        let agentTeamsPlan: Awaited<ReturnType<typeof dependencies.buildClaudeAgentTeamsLaunchPlan>>
        let sequencedStartupCommand: string | undefined
        let effectiveLaunchConfig = launchOpts.launchConfig
        try {
          const agentTeams = await buildRuntimeAgentTeamsLaunchPlan({
            launchConfig: launchOpts.launchConfig,
            command: launchOpts.command,
            claudeAgentTeamsSourceCommand: launchOpts.claudeAgentTeamsSourceCommand,
            claudeAgentTeamsMode,
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
              ? { [dependencies.SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: sequencedStartupCommand }
              : {})
          },
          paneKey,
          tabId,
          agentTeamsPlan?.env
        )
        const terminalColorQueryReplies =
          launchOpts.terminalColorQueryReplies ??
          dependencies.getTerminalViewColorQueryReplyColors()
        if (launchOpts.signal?.aborted) {
          throw new Error('client_disconnected')
        }
        let result: Awaited<ReturnType<NonNullable<dependencies.RuntimePtyController['spawn']>>>
        try {
          result = await this.ptyController.spawn({
            cols: 120,
            rows: 40,
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
            ...(terminalColorQueryReplies ? { terminalColorQueryReplies } : {}),
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
              ? { agentSessionCreateOperationId: launchOpts.agentSessionCreateOperationId }
              : {}),
            ...(launchOpts.signal ? { signal: launchOpts.signal } : {}),
            ...(launchOpts.onPtySpawnCommitted
              ? { onPtySpawnCommitted: reportPtySpawnCommitted }
              : {}),
            ...(adoptedBeforeLaunch ? { adoptedStablePane: adoptedBeforeLaunch } : {}),
            ...(launchOpts.sessionId ? { sessionId: launchOpts.sessionId } : {}),
            ...(!adoptedBeforeLaunch && launchOpts.isNewSession ? { isNewSession: true } : {}),
            persistHostSessionBinding: true
          })
        } finally {
          releaseStablePaneCreate?.()
        }
        if (!result.stablePaneOwner) {
          reportPtySpawnCommitted()
        }
        const adoptedStablePane = Boolean(result.stablePaneOwner)
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
        if (launchOpts.structuredAgentSessionId) {
          dependencies.agentSessionPtyWriteGate.bindPty(
            result.id,
            launchOpts.structuredAgentSessionId
          )
        }
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
          pty.tabId = tabId
          pty.paneKey = paneKey
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
              ...dependencies.ownerSurfacing(opts.surfaceOwner !== false),
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
    return createDesktopTerminal(this, worktreeSelector, opts, presentation, rendererWindow)
  }
}
