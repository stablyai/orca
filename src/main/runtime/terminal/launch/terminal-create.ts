import { assertTerminalCreateClientConnected } from './terminal-create-client-lifetime'
import { RetainedTerminalStartError } from '../../../../shared/workspace-layout/retained-terminal-start'
import type { TerminalWorkspaceCreationEvidence } from './terminal-workspace-scope'
import { resolveTerminalLaunchResult, terminalLaunchPublicFacts } from './terminal-launch-result'
import { revealCreatedTerminal, revealRetainedFailure } from './terminal-create-reveal'
import type { PaneSpawnOperation } from '../../../ipc/pty/pane/pane-spawn-operation'
import type { RetainedTerminalAttempt } from './retained-terminal-attempt'
import {
  runWithRetainedTerminalAttempt,
  takeRetainedTerminalAttempt
} from './retained-terminal-operation'
import { OrcaRuntimeWithTerminalCreateRegistration } from './terminal-create-registration'
import { type PaneStartArgsOf, spawnInAdmittedPane } from './runtime-pane-admission'
import type { TerminalCreateOptions } from './terminal-create-options'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-terminal-create-contract'
import {
  admitPairedCreateColors,
  getTerminalViewerColors
} from '../view/terminal-view-attribute-store'
import { resolveTerminalPresentation } from './terminal-presentation'
import {
  allocateTerminalPaneIdentity,
  materializedStablePaneReply
} from '../identity/runtime-terminal-pane-identity'
import { randomUUID } from 'node:crypto'
import type { RuntimePtyController } from '../lifecycle/runtime-pty-controller-contract'
import { terminalSpawnOptions } from './terminal-spawn-options'
import { createDesktopTerminal } from './orca-runtime-create-terminal-desktop'
import {
  terminalCreateTeamAllocation,
  prepareTerminalCreateTeamLaunch
} from './terminal-create-team-allocation'
import { createIdempotentCallback } from './pty-spawn-commit-callback'
import { agentLaunchTokenFor } from '../../../agent-launch/agent-launch-token'
import { migratedPaneRestoreHint } from '../recovery/migrated-pane-restore-cwd'
import { terminalCreateGrid } from './terminal-create-grid'
import * as dependenciesOwner1 from '../../../../shared/workspace-layout/stable-pane-id'
import type { ReplacedPaneOwner } from '../../../ipc/pty/pane/replaced-pane-owner'
import { releaseStoppedPaneBinding } from '../../../ipc/pty/pane/pane-owner-replacement'
import { BareWorkspaceTerminalLaunchError } from '../../../workspaces/catalog/workspace-git-storage'

export abstract class OrcaRuntimeWithCreateTerminal extends OrcaRuntimeWithTerminalCreateRegistration {
  protected abstract paneStartStatusArgs: PaneStartArgsOf
  abstract beginRetainedTerminalAttempt(
    worktreeId: string,
    tabId: string,
    leafId: string,
    owner: Pick<NonNullable<PaneSpawnOperation['acquisition']>, 'key' | 'reservation'> | undefined
  ): RetainedTerminalAttempt | null

  async createTerminal(
    selector?: string,
    opts: TerminalCreateOptions = {},
    // Internal creation evidence; RPC and preload callers never supply it.
    ...evidence: TerminalWorkspaceCreationEvidence
  ): Promise<RuntimeTerminalCreate> {
    if (opts.startupAgent && selector === undefined) {
      throw new Error(`startupAgent ${opts.startupAgent} requires a workspace selector.`)
    }
    const launcherSpawnArgs = admitPairedCreateColors(
      opts.terminalColorQueryReplies,
      opts.terminalViewAttributes
    )
    const presentation = resolveTerminalPresentation(opts)
    // Why: this process starts every terminal it can place, so a slow window only delays showing
    // it; a window-made create that timed out here still ran later, and a retry duplicated it.
    if (selector !== undefined) {
      const { ptyController } = this
      if (!ptyController?.spawn) {
        throw new Error('runtime_unavailable')
      }
      const workspace = await this.resolveTerminalCreateLaunchScope(selector, opts, ...evidence)
      const launchOpts = await this.resolveAgentTerminalCreateOptions(workspace, opts)
      const launchTitleAt = { sequence: this.nextTitleObservationSequence(), epochMs: Date.now() }
      let cwd = this.resolveWorkspaceTerminalStartupCwd(workspace, launchOpts.cwd) ?? workspace.path
      const session = this.getWorkspaceSessionForWorktree(workspace.id)
      const initialSize = terminalCreateGrid({
        workspaceId: workspace.id,
        launchOpts,
        opts,
        session,
        mobileActiveGroupId: this.mobileSessionTabsByWorktree.get(workspace.id)?.activeGroupId,
        singleGroupWorkspaceGridSize: this.singleGroupWorkspaceGridSize,
        terminalGroupGridSizes: this.terminalGroupGridSizes
      })
      let preAllocatedHandle =
        launchOpts.preAllocatedHandle ?? this.createPreAllocatedTerminalHandle()
      let { tabId, leafId, paneKey } = allocateTerminalPaneIdentity(launchOpts)
      const hint = migratedPaneRestoreHint(this.store, workspace, paneKey)
      const commit = createIdempotentCallback(hint.consumeThen(launchOpts.onPtySpawnCommitted))
      // Claimed before any await, so a concurrent create of this pane cannot slip in between.
      const claimedStablePaneCreate = launchOpts.preparedReplacement
        ? undefined
        : ptyController.claimStablePaneCreate?.({
            worktreeId: workspace.id,
            connectionId: workspace.connectionId,
            tabId,
            leafId
          })
      const releaseStablePaneCreate = createIdempotentCallback(claimedStablePaneCreate)
      const launchToken = agentLaunchTokenFor(launchOpts, randomUUID)
      const teamAllocation = terminalCreateTeamAllocation(this.claudeAgentTeams)
      let effectiveLaunchConfig = launchOpts.launchConfig
      let absentOwner: ReplacedPaneOwner | null = null
      let absentOwnerTransferred = false
      let result!: Awaited<ReturnType<NonNullable<RuntimePtyController['spawn']>>>
      const spawnFresh = (operation: PaneSpawnOperation) =>
        runWithRetainedTerminalAttempt(
          operation,
          launchOpts.preparedReplacement
            ? takeRetainedTerminalAttempt(launchOpts.preparedReplacement)
            : this.beginRetainedTerminalAttempt(workspace.id, tabId, leafId, operation.acquisition),
          async () => {
            const teamLaunch = await prepareTerminalCreateTeamLaunch({
              allocation: teamAllocation,
              launchOpts,
              launchToken,
              preAllocatedHandle,
              teamsMode: this.store?.getSettings?.().claudeAgentTeamsMode,
              releaseStablePaneCreate,
              buildEnv: (baseEnv, teamEnv) =>
                this.buildTerminalWorkspaceEnv(workspace, baseEnv, teamEnv)
            })
            effectiveLaunchConfig = teamLaunch.launchConfig
            const terminalColorQueryReplies = getTerminalViewerColors()
            assertTerminalCreateClientConnected(launchOpts.signal)
            try {
              const { launchAgent } = launchOpts
              launchOpts.onPtySpawnDispatched?.({
                launchConfig: effectiveLaunchConfig,
                launchAgent
              })
              result = await spawnInAdmittedPane(this.store, ptyController, {
                ...initialSize,
                ...(absentOwner
                  ? {
                      absentPaneReplacement: {
                        owner: absentOwner,
                        accept: () => {
                          absentOwnerTransferred = true
                        }
                      }
                    }
                  : {}),
                ...terminalSpawnOptions({
                  launchOpts,
                  workspace,
                  preAllocatedHandle,
                  tabId,
                  leafId,
                  terminalColorQueryReplies,
                  launcherSpawnArgs,
                  commit,
                  operation,
                  cwd,
                  teamLaunch,
                  launchToken
                }),
                ...this.paneStartStatusArgs(launchOpts)
              })
            } finally {
              releaseStablePaneCreate?.()
            }
            return result
          }
        )
      try {
        // A pane moved from another host reopens where it last was, until a spawn commits.
        cwd = (await hint.peekCwd(launchOpts.cwd)) ?? cwd
        assertTerminalCreateClientConnected(launchOpts.signal)
        const adoptedBeforeLaunch = await ptyController.adoptStablePane?.({
          ...initialSize,
          ...(launchOpts.preparedReplacement
            ? {
                reservation: launchOpts.preparedReplacement.reservation,
                stoppedPtyId: launchOpts.preparedReplacement.stoppedPtyId
              }
            : {}),
          cwd,
          connectionId: workspace.connectionId,
          worktreeId: workspace.id,
          preAllocatedHandle,
          tabId,
          leafId,
          ...(!workspace.connectionId
            ? {
                keepAbsentBinding: (owner: ReplacedPaneOwner) => {
                  absentOwner = owner
                }
              }
            : {}),
          spawnFresh,
          onOutcome: (outcome, operation) => {
            claimedStablePaneCreate?.acceptOutcome?.(outcome, operation)
            teamAllocation.acceptOutcome(outcome)
          },
          signal: launchOpts.signal
        })
        if (adoptedBeforeLaunch) {
          result = materializedStablePaneReply(adoptedBeforeLaunch, preAllocatedHandle)
          Object.assign(result, this.getTerminalLaunchResult(result.id))
        } else if (!ptyController.adoptStablePane) {
          result = await spawnFresh({ mustExist: false })
          teamAllocation.acceptFresh(result)
        }
        if (!result.stablePaneOwner) {
          commit()
        }
        hint.consume()
        const savedStartupCwd = result.savedStartupCwd ?? cwd
        // Why here: refused before a handle, snapshot or reveal could pose the live PTY as new.
        const launch = resolveTerminalLaunchResult(result, {
          ...launchOpts,
          launchConfig: effectiveLaunchConfig,
          launchToken
        })
        if (launch.surface) {
          ;({ terminalHandle: preAllocatedHandle, tabId, leafId } = launch.surface)
          paneKey = dependenciesOwner1.makePaneKey(tabId, leafId)
        }
        const { pty, handle } = this.registerCreatedTerminal({
          result,
          preAllocatedHandle,
          workspace,
          tabId,
          leafId,
          paneKey,
          launch,
          launchOpts,
          launchTitleAt,
          presentation,
          savedStartupCwd
        })
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
      } catch (error) {
        if (error instanceof RetainedTerminalStartError) {
          await revealRetainedFailure(this.notifier, error, launchOpts, { cwd, presentation })
        }
        if (
          absentOwner &&
          !absentOwnerTransferred &&
          !(error instanceof BareWorkspaceTerminalLaunchError)
        ) {
          await releaseStoppedPaneBinding(this.store ?? undefined, absentOwner)
        }
        throw error
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
