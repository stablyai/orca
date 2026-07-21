import { join } from 'node:path'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import type { SessionMeta } from './history-manager'
import type { TerminalCheckpointFile, TerminalModes } from './types'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import { getHistorySessionDirName } from './history-paths'
import { decodeTerminalHistoryLog } from './terminal-history-log'
import { HeadlessEmulator } from './headless-emulator'

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

const ALT_SCREEN_ON = '\x1b[?1049h'
const ALT_SCREEN_OFF = '\x1b[?1049l'

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
        checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf-8'))
      } catch {
        checkpoint = null
      }
    }

    // Why log replay is preferred over the checkpoint alone: the log carries
    // byte-exact output up to ~5s before the crash (up to the full-snapshot
    // cooldown, ~45s, for a streaming session mid-deferral), while the
    // checkpoint can be a full log-cap (~5MB of output) stale.
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

    let entries: { isDirectory(): boolean; name: string }[]
    try {
      entries = readdirSync(this.basePath, { withFileTypes: true })
    } catch {
      return []
    }
    const restorable: string[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }
      let sessionId: string
      try {
        sessionId = decodeURIComponent(entry.name)
      } catch {
        continue
      }
      const meta = this.readMeta(sessionId)
      if (meta && meta.endedAt === null) {
        restorable.push(sessionId)
      }
    }

    return restorable
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
      logBuffer = readFileSync(join(sessionDir, 'output.log'))
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
    const metaPath = join(this.basePath, getHistorySessionDirName(sessionId), 'meta.json')
    if (!existsSync(metaPath)) {
      return null
    }
    try {
      return JSON.parse(readFileSync(metaPath, 'utf-8'))
    } catch {
      return null
    }
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
      const scrollback = readFileSync(scrollbackPath, 'utf-8')
      const truncated = this.truncateAltScreen(scrollback)
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

  // Why: raw scrollback from TUI sessions (vim, less, htop) contains
  // alternate-screen switches that produce garbled output when replayed.
  // Truncate before the outermost unmatched alt-screen-on so only normal
  // terminal output is restored.
  private truncateAltScreen(data: string): string {
    let depth = 0
    let outermostUnmatchedOnIdx = -1

    let searchFrom = 0
    while (searchFrom < data.length) {
      const onIdx = data.indexOf(ALT_SCREEN_ON, searchFrom)
      const offIdx = data.indexOf(ALT_SCREEN_OFF, searchFrom)

      if (onIdx === -1 && offIdx === -1) {
        break
      }

      if (onIdx !== -1 && (offIdx === -1 || onIdx < offIdx)) {
        if (depth === 0) {
          outermostUnmatchedOnIdx = onIdx
        }
        depth++
        searchFrom = onIdx + ALT_SCREEN_ON.length
      } else {
        if (depth > 0) {
          depth--
        }
        searchFrom = offIdx + ALT_SCREEN_OFF.length
      }
    }

    if (depth > 0 && outermostUnmatchedOnIdx !== -1) {
      return data.slice(0, outermostUnmatchedOnIdx)
    }

    return data
  }
}
