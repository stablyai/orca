import { getAppEnvironment } from '../../shared/app-environment'
import { getOrcaUserDataPath } from '../codex/codex-home-paths'
import { scheduleHistoryGc } from '../terminal-history-gc'
import { scheduleWorktreeHistoryTreeDeletion } from '../terminal-history-deletion'
import { applyCodexSessionRetention, listPrivateCodexSessionRoots } from './codex-session-retention'
import {
  applyTerminalHistoryRetention,
  listTerminalHistoryRoots
} from './terminal-history-retention'

const RETENTION_DELAY_MS = 20_000

let scheduledRetentionTimer: ReturnType<typeof setTimeout> | null = null

/** Headless serve has no window, so this arms both the existing orphan sweep and the size/age pass. */
export function scheduleServePrivateHistoryMaintenance(
  getLiveWorktreeIds: () => Promise<Set<string>>
): void {
  scheduleHistoryGc(getLiveWorktreeIds)
  schedulePrivateSessionRetention(getLiveWorktreeIds)
}

/** Age and size retention for private Codex sessions, plus terminal history whose worktree is gone. */
export function schedulePrivateSessionRetention(
  getLiveWorktreeIds: () => Promise<Set<string>>
): void {
  if (scheduledRetentionTimer !== null) {
    return
  }
  scheduledRetentionTimer = setTimeout(() => {
    scheduledRetentionTimer = null
    void runScheduledPrivateSessionRetention(getLiveWorktreeIds)
  }, RETENTION_DELAY_MS)
  scheduledRetentionTimer.unref?.()
}

export function cancelPrivateSessionRetention(): void {
  if (scheduledRetentionTimer !== null) {
    clearTimeout(scheduledRetentionTimer)
    scheduledRetentionTimer = null
  }
}

async function runScheduledPrivateSessionRetention(
  getLiveWorktreeIds: () => Promise<Set<string>>
): Promise<void> {
  try {
    const codexUserDataPath = getOrcaUserDataPath()
    const historyUserDataPath = getAppEnvironment().getPath('userData')
    let removedRollouts = 0
    let removedRolloutBytes = 0
    for (const sessionsDir of listPrivateCodexSessionRoots(codexUserDataPath)) {
      const result = await applyCodexSessionRetention({ sessionsDir })
      removedRollouts += result.removedFiles
      removedRolloutBytes += result.removedBytes
      if (result.remainingOverCapBytes > 0) {
        console.warn(
          `[session-retention] Codex sessions still exceed the cap by ${result.remainingOverCapBytes} bytes at ${sessionsDir}`
        )
      }
    }
    const liveWorktreeIds = await getLiveWorktreeIds()
    let removedHistoryDirs = 0
    if (liveWorktreeIds.size === 0) {
      console.log('[session-retention] Skipped terminal-history: live worktree set is empty')
    } else {
      for (const historyRoot of listTerminalHistoryRoots(historyUserDataPath)) {
        const result = await applyTerminalHistoryRetention({
          historyRoot,
          liveWorktreeIds,
          removeDirectory: scheduleWorktreeHistoryTreeDeletion
        })
        removedHistoryDirs += result.removedDirectories
      }
    }
    console.log(
      `[session-retention] removedRollouts=${removedRollouts} removedRolloutBytes=${removedRolloutBytes} removedHistoryDirs=${removedHistoryDirs}`
    )
  } catch (error) {
    console.warn(
      `[session-retention] Retention failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
