import { join } from 'node:path'
import { existsSync, opendirSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { TerminalCheckpointFile } from './types'
import { getHistorySessionDirName } from './history-paths'
import { decodeTerminalHistoryLog, LOG_HEADER_BYTES } from './terminal-history-log'
import { DAEMON_RESTORE_SCROLLBACK_ROWS } from './daemon-restore-scrollback-depth'
import { HeadlessEmulator } from './headless-emulator'
import { PrioritySemaphore } from '../../shared/priority-semaphore'
import { ColdRestoreReplayWriter } from './cold-restore-replay-writer'
import { readTerminalHistoryBufferAsync } from './terminal-history-file-reader'
import { detectColdRestoreFromLegacyScrollback } from './terminal-history-legacy-scrollback-restore'
import { TERMINAL_HISTORY_LOG_MAX_BYTES } from './terminal-history-file-limits'
import {
  retainNewestRestorableTerminalHistorySessions,
  type RestorableTerminalHistorySession
} from './terminal-history-restorable-retention'
import {
  hasTerminalHistoryRecoveryProtection,
  isTerminalHistoryQuarantineEntry
} from './terminal-history-recovery-quarantine'
import { isTerminalHistoryPendingDeleteEntry } from './terminal-history-session-tombstone'
import {
  readTerminalHistoryMeta,
  type SessionMeta,
  type SessionMetaRead
} from './terminal-history-metadata'
import {
  coldRestoreInfoFromSnapshot,
  type ColdRestoreDetection,
  type ColdRestoreInfo,
  type IncrementalLogRestore
} from './terminal-history-cold-restore-info'
import { readTerminalHistoryCheckpoint } from './terminal-history-checkpoint-reader'
import { isValidTerminalHistorySize } from './terminal-history-dimensions'

export type { ColdRestoreDetection, ColdRestoreInfo } from './terminal-history-cold-restore-info'

export type RestorableHistoryProbe =
  | { status: 'none' }
  | { status: 'restorable'; sessionId: string }
  | { status: 'unreadable'; sessionId: string }

// Serialize restore replays so parallel pane mounts cannot multiply main-process work per turn.
const coldRestoreReplaySemaphore = new PrioritySemaphore(1)

export class HistoryReader {
  private basePath: string

  constructor(basePath: string) {
    this.basePath = basePath
  }

  // Check small metadata before paying for checkpoint parsing and log replay.
  probeRestorableHistory(sessionId: string): RestorableHistoryProbe {
    if (hasTerminalHistoryRecoveryProtection(this.basePath, sessionId)) {
      return { status: 'unreadable', sessionId }
    }
    const metaRead = this.readMetaState(sessionId)
    if (metaRead.status === 'unreadable') {
      return { status: 'unreadable', sessionId }
    }
    if (metaRead.status === 'missing' || metaRead.meta.endedAt !== null) {
      return { status: 'none' }
    }
    return { status: 'restorable', sessionId }
  }

  hasRestorableHistory(sessionId: string): boolean {
    return this.probeRestorableHistory(sessionId).status !== 'none'
  }

  async detectColdRestore(
    sessionId: string,
    opts?: { ignoreCleanEnd?: boolean; wslDistro?: string }
  ): Promise<ColdRestoreInfo | null> {
    const detection = await this.detectColdRestoreState(sessionId, opts)
    return detection.status === 'restored' ? detection.restoreInfo : null
  }

  async detectColdRestoreState(
    sessionId: string,
    opts?: { ignoreCleanEnd?: boolean; wslDistro?: string }
  ): Promise<ColdRestoreDetection> {
    if (hasTerminalHistoryRecoveryProtection(this.basePath, sessionId)) {
      return { status: 'unreadable', sessionId }
    }
    const metaRead = this.readMetaState(sessionId)
    if (metaRead.status === 'missing') {
      return { status: 'none' }
    }
    if (metaRead.status === 'unreadable') {
      return { status: 'unreadable', sessionId }
    }
    const meta = metaRead.meta
    // An exit can set endedAt after the spawn probe; honor eligibility already established by the caller.
    if (meta.endedAt !== null && !opts?.ignoreCleanEnd) {
      return { status: 'none' }
    }

    const sessionDir = join(this.basePath, getHistorySessionDirName(sessionId))
    const checkpointPath = join(sessionDir, 'checkpoint.json')
    const checkpointRead = await readTerminalHistoryCheckpoint(checkpointPath)
    const checkpoint = checkpointRead.status === 'readable' ? checkpointRead.checkpoint : null
    const checkpointReadFailed = checkpointRead.status === 'unreadable'

    // Incremental logs contain newer output than the last full checkpoint.
    const logRestore = await this.restoreFromIncrementalLog(
      sessionDir,
      meta,
      checkpoint,
      opts?.wslDistro
    )
    if (logRestore.restoreInfo) {
      return {
        status: 'restored',
        sessionId,
        restoreInfo: logRestore.restoreInfo,
        hasUnreadableRecovery: checkpointReadFailed || logRestore.readFailed,
        ...(logRestore.cwdFromSpawn ? { cwdFromSpawn: true } : {})
      }
    }

    if (!checkpoint) {
      // Legacy scrollback remains usable when a checkpoint is absent or corrupt.
      const legacyPath = join(sessionDir, 'scrollback.bin')
      const legacyExists = existsSync(legacyPath)
      const legacyRestore = await detectColdRestoreFromLegacyScrollback(
        this.basePath,
        sessionId,
        meta
      )
      if (legacyRestore) {
        return {
          status: 'restored',
          sessionId,
          restoreInfo: legacyRestore,
          hasUnreadableRecovery: checkpointReadFailed || logRestore.readFailed,
          cwdFromSpawn: true
        }
      }
      return checkpointReadFailed || logRestore.readFailed || legacyExists
        ? { status: 'unreadable', sessionId }
        : { status: 'none' }
    }

    return {
      status: 'restored',
      sessionId,
      restoreInfo: coldRestoreInfoFromSnapshot(checkpoint, checkpoint.cwd, meta),
      hasUnreadableRecovery: logRestore.readFailed,
      ...((checkpoint.cwd ?? null) === null ? { cwdFromSpawn: true } : {})
    }
  }

  listRestorable(): string[] {
    if (!existsSync(this.basePath)) {
      return []
    }

    let directory: ReturnType<typeof opendirSync>
    try {
      directory = opendirSync(this.basePath)
    } catch {
      return []
    }

    const sessions = function* (
      reader: HistoryReader
    ): Generator<RestorableTerminalHistorySession> {
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
        const meta = reader.readMeta(sessionId)
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
      return retainNewestRestorableTerminalHistorySessions(sessions(this))
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

  // Replay through the daemon emulator to preserve modes, alternate screens and snapshot normalization.
  private async restoreFromIncrementalLog(
    sessionDir: string,
    meta: SessionMeta,
    checkpoint: TerminalCheckpointFile | null,
    wslDistro?: string
  ): Promise<IncrementalLogRestore> {
    const logPath = join(sessionDir, 'output.log')
    try {
      // Header-only final logs need no replay slot and must not queue teardown behind startup restores.
      if ((await stat(logPath)).size <= LOG_HEADER_BYTES) {
        return { restoreInfo: null, readFailed: false }
      }
    } catch {
      return { restoreInfo: null, readFailed: existsSync(logPath) }
    }
    const release = await coldRestoreReplaySemaphore.acquire(0)
    try {
      let logBuffer: Buffer
      try {
        logBuffer = await readTerminalHistoryBufferAsync(logPath, TERMINAL_HISTORY_LOG_MAX_BYTES)
      } catch {
        return { restoreInfo: null, readFailed: true }
      }
      const log = decodeTerminalHistoryLog(logBuffer)
      if (!log || log.batches.length === 0) {
        return { restoreInfo: null, readFailed: true }
      }
      // A mismatched generation cannot extend this checkpoint; replay would duplicate or corrupt output.
      if (checkpoint) {
        if (typeof checkpoint.generation !== 'number' || log.generation !== checkpoint.generation) {
          return { restoreInfo: null, readFailed: false }
        }
      } else if (log.generation !== 0) {
        return { restoreInfo: null, readFailed: true }
      }

      const emulator = new HeadlessEmulator({
        cols: checkpoint?.cols ?? meta.cols,
        rows: checkpoint?.rows ?? meta.rows,
        scrollback: DAEMON_RESTORE_SCROLLBACK_ROWS,
        wslDistro
      })
      const replay = new ColdRestoreReplayWriter(emulator)
      try {
        if (checkpoint) {
          if (
            !(await replay.write(checkpoint.scrollbackAnsi ?? '')) ||
            !(await replay.write(checkpoint.rehydrateSequences)) ||
            !(await replay.write(checkpoint.snapshotAnsi)) ||
            !(await replay.write(checkpoint.pendingEscapeTailAnsi ?? ''))
          ) {
            return { restoreInfo: null, readFailed: true }
          }
          emulator.setRestoredOscLinks(checkpoint.oscLinks)
          if (checkpoint.lastTitle) {
            emulator.setLastTitle(checkpoint.lastTitle)
          }
        }
        for (const batch of log.batches) {
          for (const record of batch.records) {
            if (record.kind === 'output') {
              if (!(await replay.write(record.data))) {
                return { restoreInfo: null, readFailed: true }
              }
            } else if (record.kind === 'resize') {
              if (!isValidTerminalHistorySize(record.cols, record.rows)) {
                return { restoreInfo: null, readFailed: true }
              }
              await replay.resize(record.cols, record.rows)
            } else {
              await replay.clearScrollback()
            }
          }
        }
        const snapshot = emulator.getSnapshot()
        const lastBatch = log.batches.at(-1)!
        const cwd = snapshot.cwd ?? checkpoint?.cwd ?? null
        return {
          restoreInfo: coldRestoreInfoFromSnapshot(
            { ...snapshot, pendingOutputSeq: lastBatch.seq },
            cwd,
            meta
          ),
          readFailed: log.truncatedTail,
          ...(cwd === null ? { cwdFromSpawn: true } : {})
        }
      } catch {
        // Degrade to checkpoint-only restore instead of failing spawn.
        return { restoreInfo: null, readFailed: true }
      } finally {
        emulator.dispose()
      }
    } finally {
      release()
    }
  }

  private readMeta(sessionId: string): SessionMeta | null {
    const metaRead = this.readMetaState(sessionId)
    return metaRead.status === 'readable' ? metaRead.meta : null
  }

  private readMetaState(sessionId: string): SessionMetaRead {
    return readTerminalHistoryMeta(this.basePath, sessionId)
  }
}
