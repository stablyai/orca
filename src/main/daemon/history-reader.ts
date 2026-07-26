import { join } from 'node:path'
import { existsSync, opendirSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { SessionMeta } from './history-manager'
import type { TerminalCheckpointFile, TerminalModes } from './types'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import { getHistorySessionDirName } from './history-paths'
import { decodeTerminalHistoryLog, LOG_HEADER_BYTES } from './terminal-history-log'
import { HeadlessEmulator } from './headless-emulator'
import { PrioritySemaphore } from './priority-semaphore'
import { ColdRestoreReplayWriter } from './cold-restore-replay-writer'
import {
  readTerminalHistoryBufferAsync,
  readTerminalHistoryJson,
  readTerminalHistoryJsonAsync
} from './terminal-history-file-reader'
import { detectColdRestoreFromLegacyScrollback } from './terminal-history-legacy-scrollback-restore'
import {
  TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES,
  TERMINAL_HISTORY_LOG_MAX_BYTES,
  TERMINAL_HISTORY_META_MAX_BYTES
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

// Why: parallel pane mounts should interleave with main-process work without multiplying replay slices per turn.
const coldRestoreReplaySemaphore = new PrioritySemaphore(1)

export class HistoryReader {
  private basePath: string

  constructor(basePath: string) {
    this.basePath = basePath
  }

  // Why: spawn needs a cheap "could this cold-restore?" predicate before
  // deciding to pay detectColdRestore's full checkpoint+log replay. Reads only
  // the small meta.json, using the same unclean-shutdown test detectColdRestore
  // starts with.
  hasRestorableHistory(sessionId: string): boolean {
    const meta = this.readMeta(sessionId)
    return meta !== null && meta.endedAt === null
  }

  async detectColdRestore(
    sessionId: string,
    opts?: { ignoreCleanEnd?: boolean; wslDistro?: string }
  ): Promise<ColdRestoreInfo | null> {
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
        checkpoint = await readTerminalHistoryJsonAsync<TerminalCheckpointFile>(
          checkpointPath,
          TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES
        )
      } catch {
        checkpoint = null
      }
    }

    // Why log replay is preferred over the checkpoint alone: the log carries
    // byte-exact output up to ~5s before the crash (up to the full-snapshot
    // cooldown, ~45s, for a streaming session mid-deferral), while the
    // checkpoint can be a full log-cap (~5MB of output) stale.
    const logRestore = await this.restoreFromIncrementalLog(
      sessionDir,
      meta,
      checkpoint,
      opts?.wslDistro
    )
    if (logRestore) {
      return logRestore
    }

    if (!checkpoint) {
      // Why: backward compatibility with pre-checkpoint sessions, and corrupt
      // checkpoints — the old scrollback.bin is the best remaining data.
      return await detectColdRestoreFromLegacyScrollback(this.basePath, sessionId, meta)
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
  private async restoreFromIncrementalLog(
    sessionDir: string,
    meta: SessionMeta,
    checkpoint: TerminalCheckpointFile | null,
    wslDistro?: string
  ): Promise<ColdRestoreInfo | null> {
    const logPath = join(sessionDir, 'output.log')
    try {
      // Why: final checkpoints leave a header-only log; they need no scarce replay slot and must not queue sleep teardown behind startup restores.
      if ((await stat(logPath)).size <= LOG_HEADER_BYTES) {
        return null
      }
    } catch {
      return null
    }
    const release = await coldRestoreReplaySemaphore.acquire(0)
    try {
      let logBuffer: Buffer
      try {
        logBuffer = await readTerminalHistoryBufferAsync(logPath, TERMINAL_HISTORY_LOG_MAX_BYTES)
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
      const replay = new ColdRestoreReplayWriter(emulator)
      try {
        if (checkpoint) {
          if (
            !(await replay.write(checkpoint.scrollbackAnsi ?? '')) ||
            !(await replay.write(checkpoint.rehydrateSequences)) ||
            !(await replay.write(checkpoint.snapshotAnsi))
          ) {
            return null
          }
          emulator.setRestoredOscLinks(checkpoint.oscLinks)
        }
        for (const batch of log.batches) {
          for (const record of batch.records) {
            if (record.kind === 'output') {
              if (!(await replay.write(record.data))) {
                return null
              }
            } else if (record.kind === 'resize') {
              await replay.resize(record.cols, record.rows)
            } else {
              await replay.clearScrollback()
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
    } finally {
      release()
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
    const metaPath = join(this.basePath, getHistorySessionDirName(sessionId), 'meta.json')
    if (!existsSync(metaPath)) {
      return null
    }
    try {
      return readTerminalHistoryJson<SessionMeta>(metaPath, TERMINAL_HISTORY_META_MAX_BYTES)
    } catch {
      return null
    }
  }
}
