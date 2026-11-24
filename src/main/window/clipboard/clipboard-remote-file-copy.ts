import { app } from 'electron'

import {
  cleanupExpiredRemoteClipboardStaging,
  cleanupLegacyRemoteClipboardStaging
} from './clipboard-remote-file-staging'

const REMOTE_CLIPBOARD_LEGACY_CLEANUP_DELAY_MS = 30 * 1000
let legacyCleanupScheduled = false

export async function cleanupExpiredRemoteClipboardFiles(nowMs = Date.now()): Promise<void> {
  await cleanupExpiredRemoteClipboardStaging(app.getPath('temp'), nowMs)
}

export async function cleanupLegacyRemoteClipboardFiles(nowMs = Date.now()): Promise<void> {
  await cleanupLegacyRemoteClipboardStaging(app.getPath('temp'), nowMs)
}

export function scheduleLegacyRemoteClipboardFileCleanup(): void {
  if (legacyCleanupScheduled) {
    return
  }
  legacyCleanupScheduled = true
  const timer = setTimeout(() => {
    void cleanupLegacyRemoteClipboardFiles().catch(() => undefined)
  }, REMOTE_CLIPBOARD_LEGACY_CLEANUP_DELAY_MS)
  unrefTimer(timer)
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref()
  }
}
