import type { BrowserWindow } from 'electron'
import { advertisedUrlWatcher } from '../ports/advertised-url-watcher'
import { getConnectionIdsForWorktree } from '../ports/ssh-advertised-url-enrichment'
import { activeSessions } from './ssh-active-relay-sessions'
import { persistedStore } from './ssh-ipc-context'
import { broadcastDetectedPorts, broadcastPortForwards } from './ssh-renderer-broadcast'

let advertisedUrlWatcherUnsubscribe: (() => void) | null = null

export function registerAdvertisedUrlRefresh(getMainWindow: () => BrowserWindow | null): void {
  advertisedUrlWatcherUnsubscribe?.()
  // Why: SSH port scans only emit on raw host/port/PID changes, but a terminal can print the advertised URL later, so the watcher must also refresh the renderer.
  advertisedUrlWatcherUnsubscribe = advertisedUrlWatcher.onDidChange(({ worktreeId }) => {
    if (!persistedStore) {
      return
    }
    for (const targetId of getConnectionIdsForWorktree(persistedStore, worktreeId)) {
      const session = activeSessions.get(targetId)
      if (!session) {
        continue
      }
      const scanner = session.getPortScanner()
      if (scanner) {
        // Why: watcher changes can arrive before the next SSH scan refreshes listener PIDs, so don't validate PIDs against cached scanner rows.
        broadcastDetectedPorts(getMainWindow, targetId, scanner.getDetectedPorts(targetId), {
          validatePid: false
        })
      }
      broadcastPortForwards(getMainWindow, targetId)
    }
  })
}

export function unregisterAdvertisedUrlRefresh(): void {
  advertisedUrlWatcherUnsubscribe?.()
  advertisedUrlWatcherUnsubscribe = null
}
