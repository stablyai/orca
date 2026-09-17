// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithTerminalCreateDeduplication } from './orca-runtime-terminal-create-deduplication'
import * as dependencies from './orca-runtime-create-terminal-dependencies'
import { createDesktopTerminal } from './orca-runtime-create-terminal-desktop'
import { buildRuntimeAgentTeamsLaunchPlan } from './orca-runtime-agent-teams-launch-plan'
import { createPtySpawnCommitReporter } from './orca-runtime-report-pty-spawn-commit'
import { finalizeBackgroundTerminalCreate } from './orca-runtime-finalize-background-terminal'

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
        const freshAgentSessionClaim =
          !launchOpts.agentSessionClaim &&
          !launchOpts.resumeProviderSession &&
          launchToken &&
          launchOpts.launchAgent
            ? await this.createFreshAgentSessionClaim({
                worktreeId: workspace.id,
                connectionId: workspace.connectionId,
                agent: launchOpts.launchAgent,
                launchIdentity: launchToken
              })
            : null
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
            ...(launchOpts.shellOverride ? { shellOverride: launchOpts.shellOverride } : {}),
            ...(terminalColorQueryReplies ? { terminalColorQueryReplies } : {}),
            ...((launchOpts.agentSessionClaim ?? freshAgentSessionClaim)
              ? {
                  agentSessionEnsure: {
                    claim: launchOpts.agentSessionClaim ?? freshAgentSessionClaim,
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
        return finalizeBackgroundTerminalCreate(this, {
          result,
          workspace,
          launchOpts,
          presentation,
          cwd,
          preAllocatedHandle,
          tabId,
          leafId,
          paneKey,
          launchToken,
          effectiveLaunchConfig,
          reportPtySpawnCommitted,
          surfaceOwner: opts.surfaceOwner
        })
      } finally {
        releaseStablePaneCreate()
      }
    }
    return createDesktopTerminal(this, worktreeSelector, opts, presentation, rendererWindow)
  }
}
