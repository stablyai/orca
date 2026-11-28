import type { RuntimeNotifier } from './runtime-notifier-contract'
import { OrcaRuntimeWithPtyController } from '../../terminal/lifecycle/orca-runtime-pty-controller'
import { guardDesktopSurface, guardWindowRelays, type WindowRelayLists } from './window-relay-guard'
import { setRuntimeDesktopSurfaceGate } from '../../construction/runtime-desktop-surface'
import { getRuntimeBrowserPageRegistry } from '../../browser/client-pages/runtime-browser-page-registry'
import { isPersonWorkspaceKey } from '../../../../shared/workspace/identity/person-workspace-key'
import { TEAMMATE_HOMES_SESSION_PARTITION } from '../../../../shared/workspace-session/teammate-homes-session-partition'
import { tabListOfPty, windowOwns } from '../../session-tabs/person/person-workspace-target'

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

  protected countTerminalSideEffectConsumingClientEventListeners(): number {
    return this.clientEvents.countTerminalSideEffectConsumers()
  }

  /** What the window guard reads to tell a teammate's own workspace's PTYs, pages and tabs. */
  private windowRelayLists(): WindowRelayLists {
    return {
      heldPty: (ptyId) => {
        const pty = this.ptysById.get(ptyId)
        return pty !== undefined && !windowOwns(tabListOfPty(pty))
      },
      heldPage: (browserPageId) =>
        getRuntimeBrowserPageRegistry(this).heldBy(browserPageId) !== null,
      heldTab: (tabId) => this.personWorkspaceHoldsTab(tabId)
    }
  }

  private personWorkspaceHoldsTab(tabId: string): boolean {
    const saved = this.store?.getWorkspaceSession?.(TEAMMATE_HOMES_SESSION_PARTITION)
    for (const [worktreeId, snapshot] of this.mobileSessionTabsByWorktree) {
      if (
        isPersonWorkspaceKey(worktreeId) &&
        snapshot.tabs.some(
          (tab) => tab.id === tabId || (tab.type === 'terminal' && tab.parentTabId === tabId)
        )
      ) {
        return true
      }
    }
    if (!saved) {
      return false
    }
    const keys = new Set([
      ...Object.keys(saved.tabsByWorktree ?? {}),
      ...Object.keys(saved.unifiedTabs ?? {})
    ])
    for (const worktreeId of keys) {
      if (
        isPersonWorkspaceKey(worktreeId) &&
        (saved.tabsByWorktree?.[worktreeId]?.some((tab) => tab.id === tabId) ||
          saved.unifiedTabs?.[worktreeId]?.some(
            (tab) => tab.id === tabId || tab.entityId === tabId
          ))
      ) {
        return true
      }
    }
    return false
  }
}
