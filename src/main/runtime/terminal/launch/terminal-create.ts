import { prepareWorkspaceTerminalSpawn } from './prepare-workspace-terminal-spawn'
import {
  recordTerminalLaunchMetadata,
  resolveTerminalLaunchResult,
  terminalLaunchPublicFacts
} from './terminal-launch-result'
import { revealCreatedTerminal } from './terminal-create-reveal'
import type { PaneSpawnOperation } from '../../../ipc/pty/pane/pane-spawn-operation'
import { OrcaRuntimeWithPreparedTerminals } from './prepared-terminal-runtime'
import * as dependencies from '../../orca-runtime-create-terminal-dependencies'
import { createDesktopTerminal } from '../../orca-runtime-create-terminal-desktop'
import { terminalCreateTeamAllocation } from './terminal-create-team-allocation'
import { createIdempotentCallback } from '../../orca-runtime-report-pty-spawn-commit'
import { recordPtySurface, spawnSurfaceClaimSequence } from '../../pty-recorded-surface-topology'
import { agentLaunchTokenFor } from '../../../agent-launch/agent-launch-token'
import { seedPtyLaunchTitle } from './pty-launch-title'
import { migratedPaneRestoreHint } from '../../migrated-pane-restore-cwd'
import { paneSize, resolvePtyFirstSize } from '../../../ipc/pty/pty-first-size'
import { resolveLaunchCommandPaneAgent } from '../../runtime-agent-launch-resolution'

export abstract class OrcaRuntimeWithCreateTerminal extends OrcaRuntimeWithPreparedTerminals {
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
      const workspace = await this.resolveTerminalCreateLaunchScope(worktreeSelector, created, opts)
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
      const launchToken = launchOpts.attachOnly
        ? launchOpts.launchToken
        : agentLaunchTokenFor(launchOpts, dependencies.randomUUID)
      const teamAllocation = terminalCreateTeamAllocation(this.claudeAgentTeams)
      let effectiveLaunchConfig = launchOpts.launchConfig
      let result!: Awaited<ReturnType<NonNullable<dependencies.RuntimePtyController['spawn']>>>
      const spawnFresh = async (operation: PaneSpawnOperation) => {
        const admissionStore = this.store
        const prepared = await prepareWorkspaceTerminalSpawn({
          workspace,
          launchOpts,
          initialSize,
          cwd,
          preAllocatedHandle,
          tabId,
          leafId,
          launchToken,
          teamAllocation,
          releaseStablePaneCreate,
          launcherSpawnArgs,
          reportPtySpawnCommitted,
          operation,
          ports: {
            claudeAgentTeamsMode: this.store?.getSettings?.().claudeAgentTeamsMode,
            buildTerminalWorkspaceEnv: this.buildTerminalWorkspaceEnv.bind(this),
            paneStartStatusArgs: this.paneStartStatusArgs
          }
        })
        effectiveLaunchConfig = prepared.effectiveLaunchConfig
        if (launchOpts.signal?.aborted) {
          throw new Error('client_disconnected')
        }
        try {
          launchOpts.onPtySpawnDispatched?.({
            launchConfig: effectiveLaunchConfig,
            launchAgent: launchOpts.launchAgent
          })
          result = await dependencies.spawnInAdmittedPane(
            admissionStore,
            ptyController,
            prepared.spawnArgs
          )
        } finally {
          releaseStablePaneCreate()
        }
        return result
      }

      try {
        // A pane moved from another host reopens where it last was, until a spawn commits.
        cwd = (await restoreHint.peekCwd(launchOpts.cwd)) ?? cwd
        if (launchOpts.signal?.aborted) {
          throw new Error('client_disconnected')
        }
        const adoptedBeforeLaunch = launchOpts.attachOnly
          ? null
          : await ptyController.adoptStablePane?.({
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
        } else if (launchOpts.attachOnly || !ptyController.adoptStablePane) {
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
          if (!launch.adoptedStablePane || launchOpts.attachOnly) {
            seedPtyLaunchTitle(pty, launch.effectiveTitle, launchTitleAt, (title, at) =>
              this.setPtyManagementTitleFromObservedTitle(pty, title, at)
            )
          }
          recordTerminalLaunchMetadata(pty, result, launch)
          if (
            launchOpts.attachOnly &&
            launchOpts.expectedIncarnationId === pty.incarnationId &&
            pty.incarnationId
          ) {
            this.rememberRestoredOrchestrationAuthority(pty, preAllocatedHandle, pty.incarnationId)
          }
          if (!launch.adoptedStablePane || launchOpts.attachOnly) {
            pty.launchCommandAgent = result.agentResumeRefused
              ? null
              : resolveLaunchCommandPaneAgent(launchOpts.command)
            this.rememberSavedTerminalLaunchResult(result.id, result)
          }
          recordPtySurface(pty, tabId, paneKey, spawnSurfaceClaimSequence(this.graphSequence))
        }
        const handle = pty ? this.issuePtyHandle(pty) : preAllocatedHandle
        if (
          pty &&
          (!launch.adoptedStablePane || launchOpts.attachOnly) &&
          launchOpts.deferMobileSessionPublish !== true
        ) {
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
          adoptedStablePane: launch.adoptedStablePane && !launchOpts.attachOnly,
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
