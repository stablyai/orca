// Main writes and starts its owned splits under the proposed pane id; every view attaches to that terminal.
import { OrcaRuntimeWithSplitPtyBackedTerminal } from './terminal-split-surface'
import type { RuntimeTerminalSplit } from '../../../../shared/runtime-types'
import { mainOwnsTabLayout } from './main-owned-tab-layout'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { recordPtySurface, spawnSurfaceClaimSequence } from '../../pty-recorded-surface-topology'
import { runtimeSplitPlacement } from '../../runtime-terminal-spawn-placement'
import { spawnInAdmittedPane } from '../../runtime-pane-admission'
import { resolvePtyFirstSize, type PtyGridSize } from '../../../ipc/pty/pty-first-size'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import { randomUUID } from 'node:crypto'
import { paneStartFailure } from '../../pane-start-statuses'
import { collectLeafIds } from '../../../../shared/terminal-pane-layout-tree'

export type SplitPaneSource = { worktreeId: string; tabId: string; leafId: string }

export type SplitPaneInMainOptions = {
  direction: 'horizontal' | 'vertical'
  /** The caller's id for the new pane; main refuses one another pane holds. */
  newLeafId?: string
  cwd?: string
  initialSize?: PtyGridSize
  command?: string
  env?: Record<string, string>
  envToDelete?: string[]
  /** False for a split no one asked to see (an agent team's); phones keep their active tab. */
  activate?: boolean
  /** The window's own split keeps a pane whose start failed, showing why, as its spawn did. */
  keepPaneOnStartFailure?: boolean
  /** The user's own act (a CLI or window split); without it a stopped WSL distro holds the start. */
  wslUserAct?: true
}

export abstract class OrcaRuntimeWithSplitPaneInMain extends OrcaRuntimeWithSplitPtyBackedTerminal {
  /** Whether main's layout holds the tab, so main writes and starts its splits. */
  protected ownsTabLayout(worktreeId: string, tabId: string): boolean {
    return mainOwnsTabLayout(this.getWorkspaceSessionHostIdsForTab(worktreeId, tabId))
  }

  /** A window split whose start fails before main could start it still shows, with why. */
  private async keepSplitThatCannotStart(
    source: SplitPaneSource,
    opts: SplitPaneInMainOptions,
    error: unknown
  ): Promise<never> {
    if (opts.keepPaneOnStartFailure && opts.newLeafId && isTerminalLeafId(opts.newLeafId)) {
      const reply = await this.applyLayoutCommand({
        type: 'splitPane',
        workspace: source.worktreeId,
        tabId: source.tabId,
        leafId: source.leafId,
        direction: opts.direction,
        newLeafId: opts.newLeafId
      }).catch((writeError: unknown) => {
        // The caller still hears why the start failed, not why showing it did.
        console.warn('[terminal-split] could not keep a split that failed to start:', writeError)
        return null
      })
      if (reply?.ok) {
        this.paneStartStatuses?.set(
          makePaneKey(source.tabId, opts.newLeafId),
          paneStartFailure(error)
        )
      }
    }
    throw error
  }

  private holdsLeaf(worktreeId: string, leafId: string): boolean {
    const layouts = this.getWorkspaceSessionForWorktree(worktreeId)?.terminalLayoutsByTabId ?? {}
    return Object.values(layouts).some((layout) => collectLeafIds(layout?.root).includes(leafId))
  }

  /** `terminal.split` from a view that names its pane: main writes the split and starts it. */
  async splitTerminalPane(
    source: SplitPaneSource,
    opts: SplitPaneInMainOptions
  ): Promise<RuntimeTerminalSplit> {
    if (!ORCA_LAYOUT_OWNER_IS_MAIN || !this.ownsTabLayout(source.worktreeId, source.tabId)) {
      // The window then splits it as before (a paired server's tab, or the window-owned build).
      throw new Error('host_not_owned')
    }
    return this.splitPaneInMain(source, opts)
  }

  protected async splitPaneInMain(
    source: SplitPaneSource,
    opts: SplitPaneInMainOptions
  ): Promise<RuntimeTerminalSplit> {
    const leafId =
      opts.newLeafId && isTerminalLeafId(opts.newLeafId) ? opts.newLeafId : randomUUID()
    // A named pane id another pane holds is refused: the start must not land in a live pane.
    if (opts.newLeafId && this.holdsLeaf(source.worktreeId, leafId)) {
      throw new Error('pane_exists')
    }
    const controller = this.ptyController
    if (!controller?.spawn) {
      return this.keepSplitThatCannotStart(source, opts, new Error('runtime_unavailable'))
    }
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(
      `id:${source.worktreeId}`,
      undefined,
      { wslUserAct: opts.wslUserAct === true }
    ).catch((error: unknown) => this.keepSplitThatCannotStart(source, opts, error))
    const preAllocatedHandle = this.createPreAllocatedTerminalHandle()
    const result = await spawnInAdmittedPane(this.store, controller, {
      ...resolvePtyFirstSize({ pane: opts.initialSize }),
      cwd: opts.cwd ?? workspace.path,
      command: opts.command,
      commandDelivery: 'provider',
      env: this.buildTerminalWorkspaceEnv(workspace, {
        ...(workspace.connectionId ? {} : this.accounts.hostLaunchEnvFor(null)),
        ...opts.env
      }),
      envToDelete: opts.envToDelete,
      ...(opts.wslUserAct ? { wslUserAct: true } : {}),
      connectionId: workspace.connectionId,
      worktreeId: workspace.id,
      preAllocatedHandle,
      tabId: source.tabId,
      leafId,
      persistHostSessionBinding: true,
      placement: runtimeSplitPlacement(source.leafId, opts.direction),
      ...this.paneStartStatusArgs(
        opts.keepPaneOnStartFailure ? { keepPaneOnStartFailure: true } : {}
      )
    })
    this.registerPreAllocatedHandleForPty(result.id, preAllocatedHandle)
    if (result.wslDistro) {
      this.preparePtyExecutionContext(result.id, result.wslDistro)
    }
    this.registerPty(result.id, workspace.id, workspace.connectionId)
    const createdPty = this.getOrCreatePtyWorktreeRecord(result.id)
    if (!createdPty) {
      throw new Error('terminal_exited')
    }
    recordPtySurface(
      createdPty,
      source.tabId,
      makePaneKey(source.tabId, leafId),
      spawnSurfaceClaimSequence(this.graphSequence)
    )
    this.publishPtyBackedMobileSessionTerminal(workspace.id, createdPty, {
      tabId: source.tabId,
      leafId,
      title: null,
      activate: opts.activate !== false,
      split: { splitFromLeafId: source.leafId, direction: opts.direction }
    })
    return {
      handle: this.issuePtyHandle(createdPty),
      tabId: source.tabId,
      paneRuntimeId: -1,
      leafId
    }
  }
}
