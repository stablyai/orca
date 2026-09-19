import { ipcRenderer } from 'electron'
import type { RateLimitWatcherSnapshot } from '../../shared/rate-limit-watcher-types'
import type { PreloadApi } from '../api-types'

export const rateLimitWatcherApi = {
  get: (): Promise<RateLimitWatcherSnapshot> => ipcRenderer.invoke('rateLimitWatcher:get'),
  set: (tabId: string, enabled: boolean): Promise<RateLimitWatcherSnapshot> =>
    ipcRenderer.invoke('rateLimitWatcher:set', tabId, enabled)
} satisfies PreloadApi['rateLimitWatcher']
