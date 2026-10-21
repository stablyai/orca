// Layout-owner build: main's starts publish their status on the pane, and a start main could not
// make leaves its pane showing why, whether it failed before the pane was written or after.
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { LayoutApplyReply } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import type * as dependencies from '../../orca-runtime-create-terminal-dependencies'
import { PaneStartStatuses, paneStartFailure } from '../../pane-start-statuses'
import type { WindowLayoutCommand } from '../../runtime-layout-apply'
import { allocateTerminalPaneIdentity } from '../../runtime-terminal-pane-identity'
import { OrcaRuntimeWithCreateTerminal } from './terminal-create'

export type FailedStartPane = { tabId: string; leafId: string }

/** Runs `start` under ids drawn up front, so a failure at any step can still name its pane. */
export async function startKeepingFailedPane<T>(
  hinted: { tabId?: string; leafId?: string },
  start: (pane: FailedStartPane) => Promise<T>,
  keep: (pane: FailedStartPane, error: unknown) => Promise<void>
): Promise<T> {
  const { tabId, leafId } = allocateTerminalPaneIdentity(hinted)
  try {
    return await start({ tabId, leafId })
  } catch (error) {
    await keep({ tabId, leafId }, error).catch((keepError: unknown) => {
      console.warn('[terminal] could not keep the pane of a failed start:', keepError)
    })
    throw error
  }
}

export abstract class OrcaRuntimeWithFailedStartPanes extends OrcaRuntimeWithCreateTerminal {
  protected abstract markPaneLiveTitlesDirty(): void
  abstract applyLayoutCommand(command: WindowLayoutCommand): Promise<LayoutApplyReply>

  /** Switch point: main's starts into panes it already holds, published until each binds. */
  protected readonly paneStartStatuses = ORCA_LAYOUT_OWNER_IS_MAIN
    ? new PaneStartStatuses(() => this.markPaneLiveTitlesDirty())
    : null

  protected paneStartStatusArgs: dependencies.PaneStartArgsOf = (opts) => {
    const sink = this.paneStartStatuses
    return sink
      ? { startStatus: { sink, keepOnFailure: opts.keepPaneOnStartFailure === true } }
      : {}
  }

  // Not async: with the switch off this adds no await to every create.
  override createTerminal(
    worktreeSelector?: string,
    opts: dependencies.TerminalCreateOptions = {},
    created?: dependencies.Worktree
  ): Promise<dependencies.RuntimeTerminalCreate> {
    // Switch point: a start main could not make leaves its pane showing why, whatever failed.
    if (
      ORCA_LAYOUT_OWNER_IS_MAIN &&
      opts.keepPaneOnStartFailure &&
      worktreeSelector !== undefined
    ) {
      return startKeepingFailedPane(
        opts,
        (pane) =>
          opts.startFailure
            ? Promise.reject(opts.startFailure)
            : super.createTerminal(worktreeSelector, { ...opts, ...pane }, created),
        (pane, error) => this.keepFailedStartPane(worktreeSelector, created, pane, opts, error)
      )
    }
    return super.createTerminal(worktreeSelector, opts, created)
  }

  protected notePaneSleeping(paneKey: string): void {
    if (this.paneStartStatuses && !this.paneStartStatuses.peek(paneKey)) {
      this.paneStartStatuses.set(paneKey, { status: 'sleeping' })
    }
  }

  /** Through main's create rules, so a pane the user closed meanwhile is refused, not restored. */
  private async keepFailedStartPane(
    worktreeSelector: string,
    created: dependencies.Worktree | undefined,
    pane: FailedStartPane,
    { title }: dependencies.TerminalCreateOptions,
    error: unknown
  ): Promise<void> {
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(worktreeSelector, created)
    const create = { type: 'createTerminalTab' as const, workspace: workspace.id, ...pane }
    const reply = await this.applyLayoutCommand(title ? { ...create, title } : create)
    // `tab_exists`: the start wrote this pane before failing and kept it.
    if (reply.ok || reply.code === 'tab_exists') {
      this.paneStartStatuses?.set(`${pane.tabId}:${pane.leafId}`, paneStartFailure(error))
    }
  }
}
