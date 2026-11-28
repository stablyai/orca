import type { RuntimeNotifier } from './runtime-notifier-contract'
import type { RuntimePtyWorktreeRecord } from '../../terminal/records/runtime-terminal-state-records'
import { OrcaRuntimeWithPtyController } from '../../terminal/lifecycle/orca-runtime-pty-controller'
import { guardDesktopSurface, guardWindowRelays, type WindowRelayLists } from './window-relay-guard'
import { setRuntimeDesktopSurfaceGate } from '../../construction/runtime-desktop-surface'
import { getRuntimeBrowserPageRegistry } from '../../browser/client-pages/runtime-browser-page-registry'
import { tabListOfPty, windowOwns } from '../../session-tabs/person/person-workspace-target'

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

  /** The workspace whose tabs hold a live terminal (`tabListOfPty`); null for none by that id. */
  tabListOfPtyId(ptyId: string): string | null {
    const pty = this.ptysById.get(ptyId)
    return pty ? tabListOfPty(pty) : null
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
