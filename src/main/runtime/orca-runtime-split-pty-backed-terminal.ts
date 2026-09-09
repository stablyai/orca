// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithSplitTerminal } from './orca-runtime-split-terminal'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { TerminalPaneSplitSource } from '../../shared/feature-education-telemetry'
import type { RuntimeTerminalSplit } from '../../shared/runtime-types'
import { makePaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import { randomUUID } from 'node:crypto'
import { REJECTED_SPLIT_PTY_STOP_TIMEOUT_MS, ownerSurfacing } from './orca-runtime-core'

export class OrcaRuntimeWithSplitPtyBackedTerminal extends OrcaRuntimeWithSplitTerminal {
  protected async splitPtyBackedTerminal(
    pty: RuntimePtyWorktreeRecord,
    opts: {
      direction?: 'horizontal' | 'vertical'
      command?: string
      env?: Record<string, string>
      envToDelete?: string[]
      activate?: boolean
      // Why: same split as createTerminal — adopt the pane without revealing its
      // workspace, for splits the user never asked to see.
      surfaceOwner?: false
      telemetrySource?: TerminalPaneSplitSource
    } = {}
  ): Promise<RuntimeTerminalSplit> {
    if (!this.ptyController?.spawn) {
      throw new Error('runtime_unavailable')
    }
    if (!pty.connected) {
      throw new Error('terminal_exited')
    }
    const parsedPaneKey = parsePaneKey(pty.paneKey ?? '')
    const parentTabId = pty.tabId?.trim()
    if (!parentTabId || !parsedPaneKey) {
      throw new Error('terminal_handle_stale')
    }
    const direction = opts.direction ?? 'horizontal'
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(`id:${pty.worktreeId}`)
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
    const result = await this.ptyController.spawn({
      cols: 120,
      rows: 40,
      cwd: workspace.path,
      command: opts.command,
      commandDelivery: 'provider',
      env: this.buildTerminalWorkspaceEnv(workspace, opts.env ?? {}, paneKey, parentTabId),
      envToDelete: opts.envToDelete,
      connectionId: workspace.connectionId,
      worktreeId: workspace.id,
      preAllocatedHandle,
      tabId: parentTabId,
      leafId,
      persistHostSessionBinding: true,
      ...(sourceAuthority.persisted
        ? {
            expectedSourceBinding: {
              ...(sourceAuthority.persistedWorktreeId
                ? { worktreeId: sourceAuthority.persistedWorktreeId }
                : {}),
              tabId: parentTabId,
              leafId: parsedPaneKey.leafId,
              ptyId: pty.ptyId,
              // Why: the store can only match its own persisted map, so a live-only id it never
              // recorded would reject every split from a session restored without incarnations.
              // The live id is fenced by revalidateSourceAuthority below instead.
              ...(sourceAuthority.persistedIncarnationId
                ? { incarnationId: sourceAuthority.persistedIncarnationId }
                : {})
            }
          }
        : {})
    })
    this.registerPreAllocatedHandleForPty(result.id, preAllocatedHandle)
    if (result.wslDistro) {
      this.preparePtyExecutionContext(result.id, result.wslDistro)
    }
    this.registerPty(result.id, workspace.id, workspace.connectionId)
    const createdPty = this.getOrCreatePtyWorktreeRecord(result.id)
    if (createdPty) {
      createdPty.tabId = parentTabId
      createdPty.paneKey = paneKey
      createdPty.runtimeSessionOwned = pty.runtimeSessionOwned
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
        // Why: rejecting here unmounts the pane the reveal just added only because the retire
        // below always emits its exit and the tab still holds the source sibling — the renderer's
        // exit handler closes non-final panes. Never close it by tabId: that drops the whole tab.
        revalidateSourceAuthority()
      }
      if (createdPty) {
        const persisted = this.persistHeadlessTerminalSplit({
          worktreeId: workspace.id,
          tabId: parentTabId,
          leafId,
          ptyId: createdPty.ptyId,
          splitFromLeafId: parsedPaneKey.leafId,
          direction
        })
        if (sourceAuthority.persisted && !persisted) {
          throw new Error('workspace_session_unavailable')
        }
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
        this.ptyController.retireRejectedPty?.(result.id, stopped)
      } catch {
        // Best-effort cleanup; preserve the original split authority error.
      }
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
    if (sourceAuthority.persisted && committedSourceAuthority?.rendererMounted) {
      // Why: renderer adoption is a projection after the durable main commit; rejection cannot undo it.
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
