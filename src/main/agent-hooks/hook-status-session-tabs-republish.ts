import type { AgentHookServer } from './server'
import { createHookStatusSessionTabsInvalidator } from './hook-status-session-tabs-invalidation'

type SessionTabsRepublisher = {
  touchMobileSessionTabsForPane(paneKey: string, worktreeId?: string | null): void
}

type StatusStore = Pick<
  AgentHookServer,
  'subscribeEnrichedStatus' | 'subscribePaneStatusClear' | 'subscribeStatusDrop'
>

/**
 * Republish `session.tabs` whenever a pane's status row changes.
 *
 * Every producer — hook posts, the relay receivers, and main's own OSC parse — lands in the
 * store, so this is the one signal that a pane's published projection is out of date. Nothing
 * else republishes on a status-only transition, so a paired client would otherwise keep the
 * pane's last projection until an unrelated PTY touch came along (#7970).
 */
export function installHookStatusSessionTabsRepublish(
  statusStore: StatusStore,
  getRuntime: () => SessionTabsRepublisher | null | undefined
): () => void {
  const changedSessionTabs = createHookStatusSessionTabsInvalidator()
  const unsubscribeStatus = statusStore.subscribeEnrichedStatus((enriched) => {
    if (changedSessionTabs(enriched)) {
      getRuntime()?.touchMobileSessionTabsForPane(enriched.paneKey, enriched.worktreeId ?? null)
    }
  })
  // Teardown: agent exit, pane close, and the SSH transient-disconnect batch all land here.
  // Without it the live state published above becomes a zombie question card.
  const unsubscribeClear = statusStore.subscribePaneStatusClear((clear) => {
    const clearedPaneKeys =
      'paneKey' in clear ? [clear.paneKey] : changedSessionTabs.forgetConnection(clear.connectionId)
    for (const paneKey of clearedPaneKeys) {
      changedSessionTabs.forgetPane(paneKey)
      getRuntime()?.touchMobileSessionTabsForPane(paneKey)
    }
  })
  // Why a third tap: a user dismissal deletes the row without a pane clear, and it now leaves
  // `worktree ps` and the phone with it — so the paired client has to be told.
  const unsubscribeDrop = statusStore.subscribeStatusDrop((paneKey) => {
    changedSessionTabs.forgetPane(paneKey)
    getRuntime()?.touchMobileSessionTabsForPane(paneKey)
  })
  return () => {
    unsubscribeStatus()
    unsubscribeClear()
    unsubscribeDrop()
  }
}
