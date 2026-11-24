import type { TerminalSplitOptions } from './terminal-split-surface'
import type { SplitPaneInMainOptions, SplitPaneSource } from './terminal-split-in-main'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import { OrcaRuntimeWithStopExplicitlyClosedTabPtys } from '../../session-tabs/terminal-retirement/explicit-terminal-close-stops'
import type { RuntimeTerminalSplit } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import { randomUUID } from 'node:crypto'
import {
  RendererSplitLedger,
  splitRetryUnknownError,
  type RendererSplit
} from './terminal-split-retry'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import type { Worktree } from '../../../../shared/worktree/types'
import { applyRemoteViewerLaunchEnv } from './remote-viewer-launch-env'

export abstract class OrcaRuntimeWithSplitTerminal extends OrcaRuntimeWithStopExplicitlyClosedTabPtys {
  protected abstract splitPtyBackedTerminal(
    pty: RuntimePtyWorktreeRecord,
    opts?: TerminalSplitOptions,
    createdWorktree?: Worktree
  ): Promise<RuntimeTerminalSplit>

  protected abstract ownsTabLayout(worktreeId: string, tabId: string): boolean

  protected abstract splitPaneInMain(
    source: SplitPaneSource,
    opts: SplitPaneInMainOptions
  ): Promise<RuntimeTerminalSplit>

  protected abstract waitForLeafInTab(tabId: string, leafId: string): Promise<string>

  private readonly rendererSplits = new RendererSplitLedger()

  async splitTerminal(
    handle: string,
    options: TerminalSplitOptions & {
      /** The leaf id a timed-out split reported: wait for that pane instead of splitting again. */
      retrySplit?: string
    } = {},
    // Internal creation evidence; RPC and preload callers never supply it.
    createdWorktree?: Worktree
  ): Promise<RuntimeTerminalSplit> {
    const opts = applyRemoteViewerLaunchEnv(options, options.terminalImageViewerSupported)
    const livePty = this.getLivePtyForHandle(handle)
    if (livePty && opts.retrySplit) {
      // Main starts these splits itself and answers without the window, so none can be pending.
      throw splitRetryUnknownError(livePty.record.tabId, opts.retrySplit)
    }
    if (livePty) {
      return await this.splitPtyBackedTerminal(livePty.pty, opts, createdWorktree)
    }
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    const direction = opts.direction ?? 'horizontal'
    // Switch point: main writes the split and starts its terminal; the window attaches to it.
    if (ORCA_LAYOUT_OWNER_IS_MAIN && this.ownsTabLayout(leaf.worktreeId, leaf.tabId)) {
      if (opts.retrySplit) {
        throw splitRetryUnknownError(leaf.tabId, opts.retrySplit)
      }
      const cwd = leaf.ptyId
        ? await this.ptyController?.getCwd?.(leaf.ptyId).catch(() => null)
        : null
      return this.splitPaneInMain(
        { worktreeId: leaf.worktreeId, tabId: leaf.tabId, leafId: leaf.leafId },
        {
          direction,
          ...(cwd ? { cwd } : {}),
          command: opts.command,
          env: opts.env,
          envToDelete: opts.envToDelete,
          activate: opts.activate,
          ...(opts.wslUserAct ? { wslUserAct: true } : {}),
          ...(opts.preAllocatedHandle ? { preAllocatedHandle: opts.preAllocatedHandle } : {})
        }
      )
    }

    if (opts.retrySplit) {
      // Retries only wait: reissuing during a pending start or remount gap could execute the command twice.
      const split = this.rendererSplits.get(opts.retrySplit)
      if (split?.tabId !== leaf.tabId) {
        throw splitRetryUnknownError(leaf.tabId, opts.retrySplit)
      }
      return await this.awaitRendererSplit(split, opts.retrySplit)
    }
    const newLeafId = randomUUID()
    const split = { tabId: leaf.tabId, paneRuntimeId: leaf.paneRuntimeId }
    this.rendererSplits.record(newLeafId, split)
    this.notifier?.splitTerminal(leaf.tabId, leaf.paneRuntimeId, {
      direction,
      command: opts.command,
      ...(opts.terminalImageViewerSupported !== undefined ? { env: opts.env } : {}),
      worktreeId: leaf.worktreeId,
      sourceLeafId: leaf.leafId,
      telemetrySource: opts.telemetrySource,
      newLeafId,
      ...(opts.activate === false ? { activate: false } : {})
    })
    return await this.awaitRendererSplit(split, newLeafId)
  }

  private async awaitRendererSplit(
    split: RendererSplit,
    leafId: string
  ): Promise<RuntimeTerminalSplit> {
    const handle = await this.waitForLeafInTab(split.tabId, leafId)
    return { handle, tabId: split.tabId, paneRuntimeId: split.paneRuntimeId, leafId }
  }
}
