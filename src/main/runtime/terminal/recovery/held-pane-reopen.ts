// For paired desktop Reopen, stop held newer services, then start still-held panes; main's frames carry the result.

import type { NewerDaemonReopenResult } from '../../../../shared/newer-daemon-hold'
import type { PublishedWorkspaceLayout } from '../../../../shared/workspace-layout/workspace-layout-published'
import type { RestoredPane } from './restored-pane-start'

/** The pane is 'held' in the layouts main publishes: the status a paired desktop's banner shows. */
export function isPublishedHeld(
  layouts: readonly PublishedWorkspaceLayout[],
  pane: RestoredPane
): boolean {
  return layouts.some(
    (layout) =>
      layout.worktreeId === pane.worktreeId &&
      layout.tabs.some(
        (tab) =>
          tab.kind === 'terminal' &&
          tab.entityId === pane.tabId &&
          tab.terminal?.panes.some(
            (published) => published.leafId === pane.leafId && published.status === 'held'
          )
      )
  )
}

export type HeldPaneReopenPorts = {
  /** Main publishes the pane 'held' now. */
  isHeld: (pane: RestoredPane) => boolean
  /** Stops every newer terminal service this build holds for; false while one may still run. */
  stopNewerDaemons: () => Promise<boolean>
  /** The pane's one start; null when main no longer holds the pane. */
  start: (pane: RestoredPane) => Promise<string | null>
}

/** Reopened only when every pane the desktop named that main still holds now has its terminal. */
export async function reopenHeldPanes(
  panes: readonly RestoredPane[],
  ports: HeldPaneReopenPorts
): Promise<NewerDaemonReopenResult> {
  const held = new Map<string, RestoredPane>()
  for (const pane of panes) {
    const key = `${pane.tabId}:${pane.leafId}`
    if (ports.isHeld(pane)) {
      held.set(key, pane)
    }
  }
  // Why: stopping a newer build's service ends its terminals; only a hold to release warrants it.
  if (held.size === 0) {
    return { reopened: true }
  }
  if (!(await ports.stopNewerDaemons())) {
    return { reopened: false }
  }
  const started = await Promise.allSettled([...held.values()].map((pane) => ports.start(pane)))
  return {
    reopened: started.every((result) => result.status === 'fulfilled' && result.value !== null)
  }
}
