import { OrcaRuntimeWithSplitTerminal } from './terminal-split'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import type { TerminalPaneSplitSource } from '../../../../shared/feature-education-telemetry'
import type { RuntimeTerminalSplit } from '../../../../shared/runtime-types'
import { makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import { recordPtySurface, spawnSurfaceClaimSequence } from '../../pty-recorded-surface-topology'
import { randomUUID } from 'node:crypto'
import { runtimeSplitPlacement } from '../../runtime-terminal-spawn-placement'
import { REJECTED_SPLIT_PTY_STOP_TIMEOUT_MS, ownerSurfacing } from '../../orca-runtime-core'
import type { Worktree } from '../../../../shared/worktree/types'
import { spawnInAdmittedPane, withdrawRuntimePane } from '../../runtime-pane-admission'
import { UNMEASURED_PTY_SIZE } from '../../../ipc/pty/pty-first-size'
import { resolveLaunchCommandPaneAgent } from '../../runtime-agent-launch-resolution'

export type TerminalSplitOptions = {
  direction?: 'horizontal' | 'vertical'
  command?: string
  env?: Record<string, string>
  envToDelete?: string[]
  activate?: boolean
  // Why: same split as createTerminal — adopt the pane without revealing its
  // workspace, for splits the user never asked to see.
  surfaceOwner?: false
  telemetrySource?: TerminalPaneSplitSource
}

export abstract class OrcaRuntimeWithSplitPtyBackedTerminal extends OrcaRuntimeWithSplitTerminal {
  protected async splitPtyBackedTerminal(
    pty: RuntimePtyWorktreeRecord,
    opts: TerminalSplitOptions = {},
    createdWorktree?: Worktree
  ): Promise<RuntimeTerminalSplit> {
    if (!this.ptyController?.spawn) {
      throw new Error('runtime_unavailable')
    }
    if (!pty.connected) {
      throw new Error('terminal_exited')
    }
    const recorded = this.paneOfPty(pty)
    const parsedPaneKey = parsePaneKey(recorded.paneKey ?? '')
    const parentTabId = recorded.tabId?.trim()
    if (!parentTabId || !parsedPaneKey) {
      throw new Error('terminal_handle_stale')
    }
    const direction = opts.direction ?? 'horizontal'
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(
      `id:${pty.worktreeId}`,
      createdWorktree
    )
    const sourceAuthority = this.resolveTerminalSplitSourceAuthority(
      workspace.id,
      parentTabId,
      parsedPaneKey.leafId,
      pty.ptyId
    )
    if (!sourceAuthority) {
      throw new Error('terminal_split_source_not_found')
    }
    const sourceIncarnationId =
      sourceAuthority.liveIncarnationId ?? sourceAuthority.persistedIncarnationId
    const leafId = randomUUID()
    const preAllocatedHandle = this.createPreAllocatedTerminalHandle()
    const paneKey = makePaneKey(parentTabId, leafId)
    const splitArgs: Parameters<typeof spawnInAdmittedPane>[2] = {
      // Why unmeasured: a new split pane has no size of its own until the window lays it out.
      ...UNMEASURED_PTY_SIZE,
      cwd: workspace.path,
      command: opts.command,
      commandDelivery: 'provider',
      env: this.buildTerminalWorkspaceEnv(
        workspace,
        // A split is a plain shell: it takes the host's account pointer, as every create does.
        {
          ...(workspace.connectionId ? {} : this.accounts.hostLaunchEnvFor(null)),
          ...opts.env
        }
      ),
      envToDelete: opts.envToDelete,
      connectionId: workspace.connectionId,
      worktreeId: workspace.id,
      preAllocatedHandle,
      tabId: parentTabId,
      leafId,
      persistHostSessionBinding: true,
      placement: runtimeSplitPlacement(parsedPaneKey.leafId, direction),
      // Layout-owner build: views mounting the pane from main's frame attach, never spawn.
      ...this.paneStartStatusArgs({}),
      ...(sourceAuthority.persisted
        ? {
            expectedSourceBinding: {
              ...(sourceAuthority.persistedWorktreeId
                ? { worktreeId: sourceAuthority.persistedWorktreeId }
                : {}),
              tabId: parentTabId,
              leafId: parsedPaneKey.leafId,
              ptyId: pty.ptyId,
              // Persisted maps cannot match live-only incarnations; revalidateSourceAuthority fences those separately.
              ...(sourceAuthority.persistedIncarnationId
                ? { incarnationId: sourceAuthority.persistedIncarnationId }
                : {})
            }
          }
        : {})
    }
    const result = await spawnInAdmittedPane(this.store, this.ptyController, splitArgs)
    this.registerPreAllocatedHandleForPty(result.id, preAllocatedHandle)
    if (result.wslDistro) {
      this.preparePtyExecutionContext(result.id, result.wslDistro)
    }
    this.registerPty(result.id, workspace.id, workspace.connectionId)
    const createdPty = this.getOrCreatePtyWorktreeRecord(result.id)
    if (createdPty) {
      recordPtySurface(
        createdPty,
        parentTabId,
        paneKey,
        spawnSurfaceClaimSequence(this.graphSequence)
      )
      createdPty.runtimeSessionOwned = pty.runtimeSessionOwned
      createdPty.launchCommandAgent = resolveLaunchCommandPaneAgent(opts.command)
      this.setPairedRendererSessionOwnership(
        createdPty.ptyId,
        this.pairedRendererSessionOwnedPtyIds.has(pty.ptyId)
      )
    }

    const revealSplit = async (): Promise<void> => {
      await this.notifier?.revealTerminalSession?.(workspace.id, {
        ptyId: result.id,
        title: null,
        activate: opts.activate !== false,
        ...ownerSurfacing(opts.surfaceOwner !== false),
        tabId: parentTabId,
        leafId,
        splitFromLeafId: parsedPaneKey.leafId,
        splitDirection: direction,
        splitTelemetrySource: opts.telemetrySource
      })
    }

    try {
      const revalidateSourceAuthority = (): void => {
        const current = this.resolveTerminalSplitSourceAuthority(
          workspace.id,
          parentTabId,
          parsedPaneKey.leafId,
          pty.ptyId
        )
        if (
          !current ||
          (sourceAuthority.persisted && !current.persisted) ||
          (sourceIncarnationId !== null &&
            (current.liveIncarnationId ?? current.persistedIncarnationId) !== sourceIncarnationId)
        ) {
          throw new Error('terminal_split_source_not_found')
        }
      }
      revalidateSourceAuthority()
      if (!sourceAuthority.persisted) {
        await revealSplit()
        // Retirement emits a non-final pane exit and unmounts only the new pane; closing by tabId would also drop the source sibling.
        revalidateSourceAuthority()
      }
      if (createdPty) {
        this.publishPtyBackedMobileSessionTerminal(workspace.id, createdPty, {
          tabId: parentTabId,
          leafId,
          title: null,
          activate: opts.activate !== false,
          split: { splitFromLeafId: parsedPaneKey.leafId, direction }
        })
      }
    } catch (error) {
      this.setPairedRendererSessionOwnership(result.id, false)
      let stopped = false
      try {
        stopped =
          (await this.ptyController.stopAndWait?.(result.id, {
            deadlineMs: Date.now() + REJECTED_SPLIT_PTY_STOP_TIMEOUT_MS
          })) ?? false
      } catch {
        // Best-effort fallback below preserves the original split authority error.
      }
      if (!stopped) {
        try {
          this.ptyController.kill(result.id)
        } catch {
          // Best-effort cleanup; retirement below still runs and the original error still throws.
        }
      }
      try {
        this.ptyController.retireRejectedPty?.(result.id, stopped, result.incarnationId)
      } catch {
        // Best-effort cleanup; preserve the original split authority error.
      }
      await withdrawRuntimePane(this.store, splitArgs)
      throw error
    }
    const committedSourceAuthority = sourceAuthority.persisted
      ? this.resolveTerminalSplitSourceAuthority(
          workspace.id,
          parentTabId,
          parsedPaneKey.leafId,
          pty.ptyId
        )
      : null
    if (committedSourceAuthority?.persisted && !committedSourceAuthority.rendererRunsOtherPty) {
      // Reveal only projects an already durable main commit; failure cannot undo it, and lagging window graphs cannot gate it (STA-9417).
      void revealSplit().catch(() => undefined)
    }

    return {
      handle: this.issuePtyHandle(createdPty ?? pty),
      tabId: parentTabId,
      paneRuntimeId: -1,
      leafId
    }
  }
}
