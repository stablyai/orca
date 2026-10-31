import type { TerminalSplitOptions } from './terminal-split-surface'
import type { SplitPaneInMainOptions, SplitPaneSource } from './terminal-split-in-main'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import { OrcaRuntimeWithStopExplicitlyClosedTabPtys } from '../../session-tabs/explicit-terminal-close-stops'
import type { TerminalPaneSplitSource } from '../../../../shared/feature-education-telemetry'
import type { RuntimeTerminalSplit } from '../../../../shared/runtime-types'
import { randomUUID } from 'node:crypto'
import {
  RendererSplitLedger,
  splitRetryUnknownError,
  type RendererSplit
} from './terminal-split-retry'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { Worktree } from '../../../../shared/worktree/types'

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
      /** The leaf id a timed-out split reported: wait for that pane instead of splitting again. */
      retrySplit?: string
      /** The user's own act (a CLI or window split); without it a stopped WSL distro holds the start. */
      wslUserAct?: true
    } = {},
    // Internal creation evidence; RPC and preload callers never supply it.
    createdWorktree?: Worktree
  ): Promise<RuntimeTerminalSplit> {
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
          ...(opts.wslUserAct ? { wslUserAct: true } : {})
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
      worktreeId: leaf.worktreeId,
      sourceLeafId: leaf.leafId,
      telemetrySource: opts.telemetrySource,
      newLeafId
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
