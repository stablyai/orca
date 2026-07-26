import { join } from 'node:path'
import { existsSync, opendirSync } from 'node:fs'
import type { SessionMeta } from './history-manager'
import type { TerminalCheckpointFile, TerminalModes } from './types'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import { getHistorySessionDirName } from './history-paths'
import { decodeTerminalHistoryLog } from './terminal-history-log'
import { HeadlessEmulator } from './headless-emulator'
import { truncateUnclosedAlternateScreen } from './terminal-alt-screen-truncation'
import { probeTerminalHistoryMetadata } from './terminal-history-metadata-probe'
import {
  readTerminalHistoryBuffer,
  readTerminalHistoryJson,
  readTerminalHistoryText
} from './terminal-history-file-reader'
import {
  TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES,
  TERMINAL_HISTORY_LEGACY_SCROLLBACK_MAX_BYTES,
  TERMINAL_HISTORY_LOG_MAX_BYTES
} from './terminal-history-file-limits'
import {
  retainNewestRestorableTerminalHistorySessions,
  type RestorableTerminalHistorySession
} from './terminal-history-restorable-retention'

export type ColdRestoreInfo = {
  snapshotAnsi: string
  scrollbackAnsi: string
  oscLinks?: TerminalOscLinkRange[]
  rehydrateSequences: string
  cwd: string
  cols: number
  rows: number
  modes: TerminalModes
}

export type ColdRestoreProbe =
  | {
      kind:
        | 'meta-absent'
        | 'meta-corrupt'
        | 'meta-closed'
        | 'payload-absent'
        | 'payload-corrupt'
        | 'io-error'
    }
  | { kind: 'valid-snapshot'; restore: ColdRestoreInfo; truncated: false }

export class HistoryReader {
  private basePath: string

  constructor(basePath: string) {
    this.basePath = basePath
  }

  // Why: spawn avoids replaying history until metadata proves an unclean shutdown is possible.
  hasRestorableHistory(sessionId: string): boolean {
    const meta = this.readMeta(sessionId)
    return meta !== null && meta.endedAt === null
  }

  probeColdRestore(
    sessionId: string,
    opts?: { ignoreCleanEnd?: boolean; wslDistro?: string }
  ): ColdRestoreProbe {
    const meta = probeTerminalHistoryMetadata(this.basePath, sessionId)
    if (meta.kind !== 'valid') {
      return meta
    }
    if (meta.meta.endedAt !== null && !opts?.ignoreCleanEnd) {
      return { kind: 'meta-closed' }
    }
    try {
      const restore = this.detectColdRestore(sessionId, opts)
      if (restore) {
        return { kind: 'valid-snapshot', restore, truncated: false }
      }
      const sessionDir = join(this.basePath, getHistorySessionDirName(sessionId))
      const hasPayload = ['checkpoint.json', 'output.log', 'scrollback.bin'].some((name) =>
        existsSync(join(sessionDir, name))
      )
      return { kind: hasPayload ? 'payload-corrupt' : 'payload-absent' }
    } catch {
      return { kind: 'io-error' }
    }
  }

  detectColdRestore(
    sessionId: string,
    opts?: { ignoreCleanEnd?: boolean; wslDistro?: string }
  ): ColdRestoreInfo | null {
    const meta = this.readMeta(sessionId)
    if (!meta) {
      return null
    }
    // Why ignoreCleanEnd: in the spawn probe race, the dying session's exit
    // event can write endedAt between the aliveness probe and the post-spawn
    // fallback detect. The caller established restore eligibility before the
    // probe, so the just-written clean end must not downgrade the restore.
    if (meta.endedAt !== null && !opts?.ignoreCleanEnd) {
      return null
    }

    const sessionDir = join(this.basePath, getHistorySessionDirName(sessionId))
    const checkpointPath = join(sessionDir, 'checkpoint.json')
    const checkpointExists = existsSync(checkpointPath)
    let checkpoint: TerminalCheckpointFile | null = null
    if (checkpointExists) {
      try {
        checkpoint = readTerminalHistoryJson<TerminalCheckpointFile>(
          checkpointPath,
          TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES
        )
      } catch {
        checkpoint = null
      }
    }

    // Why: the incremental log is newer than a checkpoint while remaining byte-exact.
    const logRestore = this.restoreFromIncrementalLog(sessionDir, meta, checkpoint, opts?.wslDistro)
    if (logRestore) {
      return logRestore
    }

    if (!checkpoint) {
      // Why: backward compatibility with pre-checkpoint sessions, and corrupt
      // checkpoints — the old scrollback.bin is the best remaining data.
      return this.detectColdRestoreFromScrollback(sessionId, meta)
    }

    return this.coldRestoreInfoFromSnapshot(checkpoint, checkpoint.cwd, meta)
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

  // Why a scratch emulator: replaying base + raw records through the same
  // emulator the daemon used reproduces the exact terminal state at the last
  // appended batch — including alt-screen and mode handling — and reuses
  // getSnapshot()'s normalization instead of string-level reconstruction.
  private restoreFromIncrementalLog(
    sessionDir: string,
    meta: SessionMeta,
    checkpoint: TerminalCheckpointFile | null,
    wslDistro?: string
  ): ColdRestoreInfo | null {
    let logBuffer: Buffer
    try {
      logBuffer = readTerminalHistoryBuffer(
        join(sessionDir, 'output.log'),
        TERMINAL_HISTORY_LOG_MAX_BYTES
      )
    } catch {
      return null
    }
    const log = decodeTerminalHistoryLog(logBuffer)
    if (!log || log.batches.length === 0) {
      return null
    }
    // Generation mismatch means the log does not continue this checkpoint
    // (e.g. crash between checkpoint rename and log reset, or a pre-log
    // checkpoint without a generation field). Replaying it would duplicate or
    // garble content; the checkpoint alone is consistent.
    if (checkpoint) {
      if (typeof checkpoint.generation !== 'number' || log.generation !== checkpoint.generation) {
        return null
      }
    } else if (log.generation !== 0) {
      return null
    }

    const emulator = new HeadlessEmulator({
      cols: checkpoint?.cols ?? meta.cols,
      rows: checkpoint?.rows ?? meta.rows,
      wslDistro
    })
    try {
      if (checkpoint) {
        if (
          !emulator.writeSync(
            (checkpoint.scrollbackAnsi ?? '') +
              checkpoint.rehydrateSequences +
              checkpoint.snapshotAnsi
          )
        ) {
          return null
        }
        emulator.setRestoredOscLinks(checkpoint.oscLinks)
      }
      for (const batch of log.batches) {
        for (const record of batch.records) {
          if (record.kind === 'output') {
            if (!emulator.writeSync(record.data)) {
              return null
            }
          } else if (record.kind === 'resize') {
            emulator.resize(record.cols, record.rows)
          } else {
            emulator.clearScrollback()
          }
        }
      }
      const snapshot = emulator.getSnapshot()
      return this.coldRestoreInfoFromSnapshot(
        snapshot,
        snapshot.cwd ?? checkpoint?.cwd ?? meta.cwd,
        meta
      )
    } catch {
      // Why: a replay failure must degrade to checkpoint-only restore, never
      // surface as a failed spawn.
      return null
    } finally {
      emulator.dispose()
    }
  }

  private coldRestoreInfoFromSnapshot(
    snapshot: {
      snapshotAnsi: string
      scrollbackAnsi: string
      oscLinks?: TerminalOscLinkRange[]
      rehydrateSequences: string
      cols: number
      rows: number
      modes: TerminalModes
    },
    cwd: string | null,
    meta: SessionMeta
  ): ColdRestoreInfo {
    // Why: legacy normal snapshots stored their buffer only in snapshotAnsi;
    // current alt snapshots carry their normal buffer in scrollbackAnsi.
    const scrollbackAnsi =
      snapshot.scrollbackAnsi || (snapshot.modes?.alternateScreen ? '' : snapshot.snapshotAnsi)
    return {
      snapshotAnsi: snapshot.snapshotAnsi,
      scrollbackAnsi,
      oscLinks: snapshot.oscLinks,
      rehydrateSequences: snapshot.rehydrateSequences,
      cwd: cwd ?? meta.cwd,
      cols: snapshot.cols,
      rows: snapshot.rows,
      modes: snapshot.modes
    }
  }

  private readMeta(sessionId: string): SessionMeta | null {
    const result = probeTerminalHistoryMetadata(this.basePath, sessionId)
    return result.kind === 'valid' ? result.meta : null
  }

  // Why: handles the upgrade transition where sessions created before the
  // checkpoint migration still have scrollback.bin but no checkpoint.json.
  private detectColdRestoreFromScrollback(
    sessionId: string,
    meta: SessionMeta
  ): ColdRestoreInfo | null {
    const scrollbackPath = join(
      this.basePath,
      getHistorySessionDirName(sessionId),
      'scrollback.bin'
    )
    if (!existsSync(scrollbackPath)) {
      return null
    }
    try {
      const scrollback = readTerminalHistoryText(
        scrollbackPath,
        TERMINAL_HISTORY_LEGACY_SCROLLBACK_MAX_BYTES
      )
      const truncated = truncateUnclosedAlternateScreen(scrollback)
      return {
        snapshotAnsi: truncated,
        scrollbackAnsi: truncated,
        rehydrateSequences: '',
        cwd: meta.cwd,
        cols: meta.cols,
        rows: meta.rows,
        modes: {
          bracketedPaste: false,
          mouseTracking: false,
          applicationCursor: false,
          alternateScreen: false
        }
      }
    } catch {
      return null
    }
  }
}
