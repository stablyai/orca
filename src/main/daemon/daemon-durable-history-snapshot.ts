import { ColdRestoreReplayWriter } from './cold-restore-replay-writer'
import { DAEMON_RESTORE_SCROLLBACK_ROWS } from './daemon-restore-scrollback-depth'
import { HeadlessEmulator } from './headless-emulator'
import { isValidTerminalHistorySize } from './terminal-history-dimensions'
import type { ColdRestoreInfo } from './terminal-history-cold-restore-info'
import type { PendingOutputRecord, TerminalSnapshot } from './types'

type RestoreBase = {
  scrollbackAnsi: string
  rehydrateSequences: string
  snapshotAnsi: string
  pendingEscapeTailAnsi?: string
  oscLinks?: TerminalSnapshot['oscLinks']
  lastTitle?: string
  cwd: string | null
  cols: number
  rows: number
}

export function terminalSnapshotFromColdRestore(
  info: ColdRestoreInfo,
  opts?: { outputSequence?: number; frameRestoreAnsi?: string }
): TerminalSnapshot {
  return {
    snapshotAnsi: info.snapshotAnsi,
    scrollbackAnsi: info.modes.alternateScreen ? info.scrollbackAnsi : '',
    oscLinks: info.oscLinks,
    rehydrateSequences: info.rehydrateSequences,
    ...(info.pendingEscapeTailAnsi ? { pendingEscapeTailAnsi: info.pendingEscapeTailAnsi } : {}),
    ...(opts?.frameRestoreAnsi ? { frameRestoreAnsi: opts.frameRestoreAnsi } : {}),
    cwd: info.cwd,
    modes: info.modes,
    cols: info.cols,
    rows: info.rows,
    scrollbackLines:
      info.scrollbackLines ?? Math.max(0, countAnsiRows(info.scrollbackAnsi) - info.rows),
    ...(info.lastTitle ? { lastTitle: info.lastTitle } : {}),
    ...(opts?.outputSequence !== undefined ? { outputSequence: opts.outputSequence } : {})
  }
}

export async function buildDurableCheckpointSnapshot(opts: {
  liveSnapshot: TerminalSnapshot
  restoreInfo: ColdRestoreInfo | null
  pendingRecords?: readonly PendingOutputRecord[]
  scrollbackRows?: number
}): Promise<TerminalSnapshot> {
  const pendingRecords = opts.pendingRecords ?? []
  if (!opts.restoreInfo && pendingRecords.length === 0) {
    return opts.liveSnapshot
  }
  if (
    opts.restoreInfo &&
    pendingRecords.length === 0 &&
    (opts.scrollbackRows === undefined || opts.scrollbackRows >= DAEMON_RESTORE_SCROLLBACK_ROWS)
  ) {
    return terminalSnapshotFromColdRestore(opts.restoreInfo, {
      outputSequence: opts.liveSnapshot.outputSequence,
      frameRestoreAnsi: opts.liveSnapshot.frameRestoreAnsi
    })
  }

  const emulator = new HeadlessEmulator({
    cols: opts.restoreInfo?.cols ?? opts.liveSnapshot.cols,
    rows: opts.restoreInfo?.rows ?? opts.liveSnapshot.rows,
    scrollback: Math.min(
      opts.scrollbackRows ?? DAEMON_RESTORE_SCROLLBACK_ROWS,
      DAEMON_RESTORE_SCROLLBACK_ROWS
    )
  })
  const replay = new ColdRestoreReplayWriter(emulator)
  try {
    // Why not seed the live window when there is no disk history: pending records
    // are the raw stream. Replaying them on top of the already-truncated live
    // snapshot would duplicate the newest rows and evict the older recoverable ones.
    if (opts.restoreInfo) {
      const base = restoreBaseFrom(opts.restoreInfo)
      for (const segment of [
        base.scrollbackAnsi,
        base.rehydrateSequences,
        base.snapshotAnsi,
        base.pendingEscapeTailAnsi ?? ''
      ]) {
        if (!(await replay.write(segment))) {
          return opts.liveSnapshot
        }
      }
      emulator.setRestoredOscLinks(base.oscLinks)
      if (base.lastTitle) {
        emulator.setLastTitle(base.lastTitle)
      }
      emulator.setCwd(base.cwd)
    }
    if (!(await replayPendingRecords(replay, pendingRecords))) {
      return opts.liveSnapshot
    }
    const snapshot = emulator.getSnapshot()
    return {
      ...snapshot,
      ...(opts.liveSnapshot.outputSequence !== undefined
        ? { outputSequence: opts.liveSnapshot.outputSequence }
        : {}),
      ...(opts.liveSnapshot.frameRestoreAnsi && !snapshot.frameRestoreAnsi
        ? { frameRestoreAnsi: opts.liveSnapshot.frameRestoreAnsi }
        : {})
    }
  } catch (error) {
    console.warn('[history] durable snapshot rebuild failed:', error)
    return opts.liveSnapshot
  } finally {
    emulator.dispose()
  }
}

function restoreBaseFrom(restoreInfo: ColdRestoreInfo): RestoreBase {
  return {
    scrollbackAnsi: restoreInfo.modes.alternateScreen ? restoreInfo.scrollbackAnsi : '',
    rehydrateSequences: restoreInfo.rehydrateSequences,
    snapshotAnsi: restoreInfo.snapshotAnsi,
    ...(restoreInfo.pendingEscapeTailAnsi
      ? { pendingEscapeTailAnsi: restoreInfo.pendingEscapeTailAnsi }
      : {}),
    oscLinks: restoreInfo.oscLinks,
    lastTitle: restoreInfo.lastTitle,
    cwd: restoreInfo.cwd,
    cols: restoreInfo.cols,
    rows: restoreInfo.rows
  }
}

async function replayPendingRecords(
  replay: ColdRestoreReplayWriter,
  records: readonly PendingOutputRecord[]
): Promise<boolean> {
  for (const record of records) {
    if (record.kind === 'output') {
      if (!(await replay.write(record.data))) {
        return false
      }
      continue
    }
    if (record.kind === 'resize') {
      if (!isValidTerminalHistorySize(record.cols, record.rows)) {
        return false
      }
      await replay.resize(record.cols, record.rows)
      continue
    }
    await replay.clearScrollback()
  }
  return true
}

function countAnsiRows(ansi: string): number {
  if (ansi.length === 0) {
    return 0
  }
  return ansi.split(/\r\n|\n|\r/).filter((row) => row.length > 0).length
}
