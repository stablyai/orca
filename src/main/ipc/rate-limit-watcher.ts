import { ipcMain } from 'electron'
import type { RateLimitWatcherSnapshot } from '../../shared/rate-limit-watcher-types'

type RateLimitWatcherStore = {
  listRateLimitWatcherTabs: () => string[]
  setRateLimitWatcherEnabled: (tabId: string, enabled: boolean) => void
}

const CHANNELS = ['rateLimitWatcher:get', 'rateLimitWatcher:set'] as const

/** Main owns the armed set, so the auto-resume gate and the checkbox can never
 *  disagree. `set` returns the new snapshot rather than pushing one on a
 *  separate channel: the renderer is the only writer, so there is no third-party
 *  change for it to miss.
 *
 *  `onArmed` fires after a tab is enabled, so a stall detected while the box
 *  was unticked — and therefore dropped — can be re-announced. Without it,
 *  arming the watcher on an agent already parked at the chooser does nothing:
 *  a parked agent emits no output, so detection never fires again. */
export function registerRateLimitWatcherHandlers(
  store: RateLimitWatcherStore,
  hooks: { onArmed?: (tabId: string) => void } = {}
): void {
  for (const channel of CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  const snapshot = (): RateLimitWatcherSnapshot => ({ tabIds: store.listRateLimitWatcherTabs() })
  ipcMain.handle('rateLimitWatcher:get', (): RateLimitWatcherSnapshot => snapshot())
  ipcMain.handle(
    'rateLimitWatcher:set',
    (_event, tabId: string, enabled: boolean): RateLimitWatcherSnapshot => {
      store.setRateLimitWatcherEnabled(tabId, enabled)
      if (enabled) {
        hooks.onArmed?.(tabId)
      }
      return snapshot()
    }
  )
}
