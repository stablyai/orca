import { existsSync, opendirSync } from 'node:fs'
import { readTerminalHistoryMeta } from '../storage/terminal-history-metadata'
import { isTerminalHistoryQuarantineEntry } from '../storage/terminal-history-recovery-quarantine'
import { isTerminalHistoryPendingDeleteEntry } from '../storage/terminal-history-session-tombstone'
import {
  retainNewestRestorableTerminalHistorySessions,
  type RestorableTerminalHistorySession
} from './terminal-history-restorable-retention'

export function listRestorableTerminalHistory(basePath: string): string[] {
  if (!existsSync(basePath)) {
    return []
  }

  let directory: ReturnType<typeof opendirSync>
  try {
    directory = opendirSync(basePath)
  } catch {
    return []
  }

  const sessions = function* (): Generator<RestorableTerminalHistorySession> {
    let order = 0
    while (true) {
      const entry = directory.readSync()
      if (!entry) {
        return
      }
      if (!entry.isDirectory()) {
        continue
      }
      if (
        isTerminalHistoryQuarantineEntry(entry.name) ||
        isTerminalHistoryPendingDeleteEntry(entry.name)
      ) {
        continue
      }
      let sessionId: string
      try {
        sessionId = decodeURIComponent(entry.name)
      } catch {
        continue
      }
      const metaRead = readTerminalHistoryMeta(basePath, sessionId)
      const meta = metaRead.status === 'readable' ? metaRead.meta : null
      if (meta && meta.endedAt === null) {
        const parsedStartedAt = Date.parse(meta.startedAt)
        yield {
          sessionId,
          startedAtMs: Number.isFinite(parsedStartedAt) ? parsedStartedAt : 0,
          order
        }
        order += 1
      }
    }
  }

  try {
    return retainNewestRestorableTerminalHistorySessions(sessions())
  } catch {
    return []
  } finally {
    try {
      directory.closeSync()
    } catch {
      // Best effort after a directory read failure.
    }
  }
}
