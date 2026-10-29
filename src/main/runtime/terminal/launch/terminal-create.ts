import {
  recordTerminalLaunchMetadata,
  resolveTerminalLaunchResult,
  terminalLaunchPublicFacts
} from './terminal-launch-result'
import { revealCreatedTerminal } from './terminal-create-reveal'
import type { PaneSpawnOperation } from '../../../ipc/pty/pane/pane-spawn-operation'
import { OrcaRuntimeWithTerminalCreateDeduplication } from './terminal-create-deduplication'
import * as dependencies from '../../orca-runtime-create-terminal-dependencies'
import { createDesktopTerminal } from '../../orca-runtime-create-terminal-desktop'
import { terminalCreateTeamAllocation } from './terminal-create-team-allocation'
import { createIdempotentCallback } from '../../orca-runtime-report-pty-spawn-commit'
import { recordPtySurface, spawnSurfaceClaimSequence } from '../../pty-recorded-surface-topology'
import { agentLaunchTokenFor, withAgentLaunchToken } from '../../../agent-launch/agent-launch-token'
import { seedPtyLaunchTitle } from './pty-launch-title'
import { migratedPaneRestoreHint } from '../../migrated-pane-restore-cwd'
import { paneSize, resolvePtyFirstSize } from '../../../ipc/pty/pty-first-size'
import { resolveLaunchCommandPaneAgent } from '../../runtime-agent-launch-resolution'

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
    const launcherSpawnArgs = dependencies.admitPairedCreateColors(
      opts.terminalColorQueryReplies,
      opts.terminalViewAttributes
    )
    const presentation = dependencies.resolveTerminalPresentation(opts)
    // Start host-placeable terminals here; timing out a window-made start still ran it later and retries duplicated it.
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
      // Unshown workspaces have no measured group; a single group can use the common workspace geometry.
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
      const teamAllocation = terminalCreateTeamAllocation(this.claudeAgentTeams)
      let effectiveLaunchConfig = launchOpts.launchConfig
      let result!: Awaited<ReturnType<NonNullable<dependencies.RuntimePtyController['spawn']>>>
      const spawnFresh = async (operation: PaneSpawnOperation) => {
        const baseEnv = withAgentLaunchToken(launchOpts.env, launchToken)
        const agentTeams = await teamAllocation
          .prepare(
            {
              launchConfig: launchOpts.launchConfig,
              command: launchOpts.command,
              claudeAgentTeamsSourceCommand: launchOpts.claudeAgentTeamsSourceCommand,
              claudeAgentTeamsMode: this.store?.getSettings?.().claudeAgentTeamsMode,
              baseEnv: { ...process.env, ...baseEnv },
              adoptedBeforeLaunch: null
            },
            preAllocatedHandle
          )
          .catch((error: unknown) => {
            releaseStablePaneCreate()
            throw error
          })
        const { plan: agentTeamsPlan, sequencedStartupCommand } = agentTeams
        effectiveLaunchConfig = agentTeams.effectiveLaunchConfig
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
            launchConfig: effectiveLaunchConfig,
            ...(launchToken ? { launchToken } : {}),
            commandDelivery: 'provider',
            startupCommandDelivery: launchOpts.startupCommandDelivery,
            env,
            envToDelete: dependencies.mergeTerminalEnvDeletionKeys(
              launchOpts.envToDelete,
              agentTeamsPlan?.envToDelete
            ),
            resumeProviderSession: launchOpts.resumeProviderSession,
            ...(launchOpts.resumeOrigin ? { resumeOrigin: launchOpts.resumeOrigin } : {}),
            telemetry: launchOpts.telemetry,
            connectionId: workspace.connectionId,
            worktreeId: workspace.id,
            preAllocatedHandle,
            tabId,
            leafId,
            ...dependencies.spawnShellInputs(launchOpts),
            ...(terminalColorQueryReplies ? { terminalColorQueryReplies } : {}),
            ...launcherSpawnArgs,
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
          onOutcome: (outcome, operation) => {
            claimedStablePaneCreate?.acceptOutcome?.(outcome, operation)
            teamAllocation.acceptOutcome(outcome)
          },
          signal: launchOpts.signal
        })
        if (adoptedBeforeLaunch) {
          result = dependencies.materializedStablePaneReply(adoptedBeforeLaunch, preAllocatedHandle)
          Object.assign(result, this.getTerminalLaunchResult(result.id))
        } else if (!ptyController.adoptStablePane) {
          result = await spawnFresh({ mustExist: false })
          teamAllocation.acceptFresh(result)
        }
        if (!result.stablePaneOwner) {
          reportPtySpawnCommitted()
        }
        restoreHint.consume()
        const savedStartupCwd = result.savedStartupCwd ?? cwd
        // Why here: refused before a handle, snapshot or reveal could pose the live PTY as new.
        const launch = resolveTerminalLaunchResult(result, {
          ...launchOpts,
          launchConfig: effectiveLaunchConfig,
          launchToken
        })
        if (launch.surface) {
          ;({ terminalHandle: preAllocatedHandle, tabId, leafId } = launch.surface)
          paneKey = dependencies.makePaneKey(tabId, leafId)
        }
        this.assertCreatedPtyRegistrationAllowed(result.id, result.incarnationId)
        // Provider reattachment still needs this runtime's handle and workspace binding.
        if (!result.stablePaneOwner) {
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
          if (!launch.adoptedStablePane) {
            seedPtyLaunchTitle(pty, launch.effectiveTitle, launchTitleAt, (title, at) =>
              this.setPtyManagementTitleFromObservedTitle(pty, title, at)
            )
          }
          recordTerminalLaunchMetadata(pty, result, launch)
          if (!launch.adoptedStablePane) {
            pty.launchCommandAgent = result.agentResumeRefused
              ? null
              : resolveLaunchCommandPaneAgent(launchOpts.command)
            this.rememberSavedTerminalLaunchResult(result.id, result)
          }
          recordPtySurface(pty, tabId, paneKey, spawnSurfaceClaimSequence(this.graphSequence))
        }
        const handle = pty ? this.issuePtyHandle(pty) : preAllocatedHandle
        if (pty && !launch.adoptedStablePane && launchOpts.deferMobileSessionPublish !== true) {
          this.publishPtyBackedMobileSessionTerminal(workspace.id, pty, {
            tabId,
            leafId,
            title: launch.effectiveTitle ?? null,
            activate: presentation === 'focused',
            selectIfNoActiveTab: presentation !== 'background',
            ...(launch.effectiveViewMode ? { viewMode: launch.effectiveViewMode } : {}),
            ...(savedStartupCwd !== workspace.path ? { startupCwd: savedStartupCwd } : {})
          })
        }
        const reveal = revealCreatedTerminal({
          notifier: this.notifier,
          workspace,
          ptyId: result.id,
          handle,
          cwd: savedStartupCwd,
          launchOpts: {
            ...launchOpts,
            title: pty?.title ?? launch.effectiveTitle ?? undefined,
            launchAgent: pty?.launchAgent ?? undefined,
            viewMode: launch.effectiveViewMode
          },
          effectiveLaunchConfig: pty?.launchConfig ?? undefined,
          launchToken: pty?.launchToken ?? undefined,
          adoptedStablePane: launch.adoptedStablePane,
          presentation,
          opts,
          tabId,
          leafId
        })
        const { surface, warning } = reveal instanceof Promise ? await reveal : reveal
        return {
          ...terminalLaunchPublicFacts(result, launch.adoptedStablePane, pty),
          handle,
          savedStartupCwd,
          tabId,
          paneKey,
          ptyId: result.id,
          worktreeId: workspace.id,
          title: pty?.title ?? launch.effectiveTitle ?? null,
          ...this.getPtyExecutionHostMetadata(result.id),
          surface,
          ...(result.startupCwdFallback ? { startupCwdFallback: result.startupCwdFallback } : {}),
          ...(warning ? { warning } : {})
        }
      } finally {
        teamAllocation.release()
        releaseStablePaneCreate()
      }
    }
    // The renderer owns this spawn, so this process cannot see when it is requested.
    opts.onPtySpawnDispatched?.()
    return createDesktopTerminal(this, opts, presentation)
  }
}
