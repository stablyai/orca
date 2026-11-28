import type { RuntimeNotifier } from './runtime-notifier-contract'
import type { RuntimePtyWorktreeRecord } from '../../terminal/records/runtime-terminal-state-records'
import { OrcaRuntimeWithPtyController } from '../../terminal/lifecycle/orca-runtime-pty-controller'
import { guardDesktopSurface, guardWindowRelays, type WindowRelayLists } from './window-relay-guard'
import { setRuntimeDesktopSurfaceGate } from '../../construction/runtime-desktop-surface'
import { getRuntimeBrowserPageRegistry } from '../../browser/client-pages/runtime-browser-page-registry'
import { tabListOfPty, windowOwns } from '../../session-tabs/person/person-workspace-target'
import { teammateListHoldsPane } from '../../session-tabs/restoration/status-pane-placement'

/** A workspace, or a terminal whose tabs' workspace is its holder's list. */
export type WindowTarget = string | Pick<RuntimePtyWorktreeRecord, 'worktreeId' | 'holder'>

export abstract class RuntimeNotifierBinding extends OrcaRuntimeWithPtyController {
  setNotifier(notifier: RuntimeNotifier | null): void {
    const lists = this.windowRelayLists()
    this.notifier = notifier ? guardWindowRelays(notifier, lists) : null
    setRuntimeDesktopSurfaceGate(notifier ? (surface) => guardDesktopSurface(surface, lists) : null)
    if (notifier) {
      this.repositoryForkBackfill.start()
      queueMicrotask(() => this.retrySleptMailboxWakes())
    }
  }

  /** The window's notifier for a workspace's tabs, or a terminal's; none for a teammate's own
   *  workspace, which no window shows. */
  protected windowNotifierFor(of: WindowTarget): RuntimeNotifier | null {
    return windowOwns(this.tabWorkspaceOf(of)) ? this.notifier : null
  }

  /** The workspace whose tabs a target is: itself, or a terminal's holder's list (`tabListOfPty`). */
  protected tabWorkspaceOf(of: WindowTarget): string {
    return typeof of === 'string' ? of : tabListOfPty(of)
  }

  /** A live terminal's record, for the classifiers that place its facts (`hostListPty`). */
  ptyRecordOf(ptyId: string): Pick<RuntimePtyWorktreeRecord, 'holder' | 'worktreeId'> | undefined {
    return this.ptysById.get(ptyId)
  }

  /** Whether a teammate's own workspace lists a pane, for a status no live terminal places. */
  teammateListHoldsPane(paneKey: string): boolean {
    return teammateListHoldsPane(this.store, paneKey)
  }

  protected countTerminalSideEffectConsumingClientEventListeners(): number {
    return this.clientEvents.countTerminalSideEffectConsumers()
  }

  /** What the window guard reads to tell a teammate's own workspace's PTYs, pages and tabs. */
  protected windowRelayLists(): WindowRelayLists {
    return {
      heldPty: (ptyId) => {
        const pty = this.ptysById.get(ptyId)
        return pty !== undefined && !windowOwns(tabListOfPty(pty))
      },
      heldPage: (browserPageId) =>
        getRuntimeBrowserPageRegistry(this).heldBy(browserPageId) !== null
    }
  }
}
