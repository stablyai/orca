import { ColdRestoreReplayWriter } from './cold-restore-replay-writer'
import { DAEMON_RESTORE_SCROLLBACK_ROWS } from './daemon-restore-scrollback-depth'
import {
  DurableHistoryReplayEmulator,
  type NormalBufferHead
} from './durable-history-replay-emulator'
import { isValidTerminalHistorySize } from './terminal-history-dimensions'
import { getRecoveredHistorySeedSegments } from './terminal-history-seed-segments'
import { replayTerminalSnapshot } from './terminal-checkpoint-serializer'
import { RESET_GRAPHIC_RENDITION } from '../../shared/terminal-mode-reset-profiles'
import type { ColdRestoreInfo } from './terminal-history-cold-restore-info'
import type { PendingOutputRecord, TerminalSnapshot } from './types'

// Why: the head's serializer ends on the replay's pen and open hyperlink; the live body assumes defaults.
const OLDER_ROWS_SEAM = `${RESET_GRAPHIC_RENDITION}\x1b]8;;\x1b\\`

/** Live is the authority for everything it holds; disk only adds normal-buffer rows live evicted. */
export async function buildDurableCheckpointSnapshot(opts: {
  liveSnapshot: TerminalSnapshot
  restoreInfo: ColdRestoreInfo | null
  pendingRecords: readonly PendingOutputRecord[]
  /** Records span the live session's whole life, so restoreInfo is the base it was seeded from. */
  isFirstTake: boolean
}): Promise<TerminalSnapshot> {
  const { liveSnapshot, restoreInfo, pendingRecords } = opts
  if (!restoreInfo && pendingRecords.length === 0) {
    return liveSnapshot
  }
  // Why not on a first fold: live was seeded with disk plus the ground, so disk is never live's copy.
  if (
    restoreInfo &&
    pendingRecords.length === 0 &&
    !opts.isFirstTake &&
    diskCheckpointAgreesWithLive(restoreInfo, liveSnapshot)
  ) {
    return diskCheckpointWithLiveIdentity(restoreInfo, liveSnapshot)
  }

  // Why the base's dims: a cold restore spawns and seeds the live session at them.
  const emulator = new DurableHistoryReplayEmulator({
    cols: restoreInfo?.cols ?? liveSnapshot.cols,
    rows: restoreInfo?.rows ?? liveSnapshot.rows,
    scrollback: DAEMON_RESTORE_SCROLLBACK_ROWS
  })
  const replay = new ColdRestoreReplayWriter(emulator)
  try {
    if (restoreInfo) {
      // Why the seed on a first fold: live got exactly those bytes, so both copies' rows line up
      // even when the base was a dead TUI's alt screen.
      const segments = opts.isFirstTake
        ? getRecoveredHistorySeedSegments(restoreInfo)
        : restoreSegments(restoreInfo)
      for (const segment of segments) {
        if (!(await replay.write(segment))) {
          return liveSnapshot
        }
      }
    }
    if (!(await replayPendingRecords(replay, pendingRecords))) {
      return liveSnapshot
    }
    if (!isValidTerminalHistorySize(liveSnapshot.cols, liveSnapshot.rows)) {
      return liveSnapshot
    }
    // Why: rows are counted from the bottom, so both buffers must wrap on the same grid.
    await replay.resize(liveSnapshot.cols, liveSnapshot.rows)
    const head = emulator.serializeNormalBufferHead(
      liveSnapshot.scrollbackLines + liveSnapshot.rows
    )
    return {
      ...rebaseOnOlderRows(liveSnapshot, head),
      ...(!liveSnapshot.cwd && restoreInfo?.cwd ? { cwd: restoreInfo.cwd } : {}),
      ...(!liveSnapshot.lastTitle && restoreInfo?.lastTitle
        ? { lastTitle: restoreInfo.lastTitle }
        : {})
    }
  } catch (error) {
    console.warn('[history] durable snapshot rebuild failed:', error)
    return liveSnapshot
  } finally {
    emulator.dispose()
  }
}

/** True when disk already holds live's grid, modes and alt frame, so a rebase would change nothing. */
function diskCheckpointAgreesWithLive(info: ColdRestoreInfo, live: TerminalSnapshot): boolean {
  return (
    info.cols === live.cols &&
    info.rows === live.rows &&
    info.rehydrateSequences === live.rehydrateSequences &&
    info.modes.kittyKeyboardFlags === live.modes.kittyKeyboardFlags &&
    (!live.modes.alternateScreen || info.snapshotAnsi === live.snapshotAnsi)
  )
}

function diskCheckpointWithLiveIdentity(
  info: ColdRestoreInfo,
  live: TerminalSnapshot
): TerminalSnapshot {
  const { terminalOwner: _diskOwner, pendingOutputSeq: _diskSeq, ...disk } = info
  return {
    ...disk,
    // Why: a normal-screen snapshotAnsi already holds its scrollback.
    scrollbackAnsi: info.modes.alternateScreen ? info.scrollbackAnsi : '',
    scrollbackLines:
      info.scrollbackLines ?? Math.max(0, countAnsiRows(info.scrollbackAnsi) - info.rows),
    ...(live.frameRestoreAnsi ? { frameRestoreAnsi: live.frameRestoreAnsi } : {}),
    ...(live.terminalOwner ? { terminalOwner: live.terminalOwner } : {}),
    ...(live.outputSequence !== undefined ? { outputSequence: live.outputSequence } : {})
  }
}

/** Trims a snapshot to `scrollbackRows` of scrollback, keeping its owner and sequence. */
export async function boundSnapshot(
  snapshot: TerminalSnapshot,
  scrollbackRows: number
): Promise<TerminalSnapshot> {
  const emulator = await replayTerminalSnapshot(snapshot, { scrollbackRows })
  try {
    return {
      ...emulator.getSnapshot(),
      ...(snapshot.terminalOwner ? { terminalOwner: snapshot.terminalOwner } : {}),
      ...(snapshot.outputSequence !== undefined ? { outputSequence: snapshot.outputSequence } : {})
    }
  } finally {
    emulator.dispose()
  }
}

function restoreSegments(restoreInfo: ColdRestoreInfo): string[] {
  return [
    // Why alt only: a normal-screen snapshotAnsi already holds its scrollback.
    restoreInfo.modes.alternateScreen ? restoreInfo.scrollbackAnsi : '',
    restoreInfo.rehydrateSequences,
    restoreInfo.snapshotAnsi,
    restoreInfo.pendingEscapeTailAnsi ?? ''
  ]
}

function rebaseOnOlderRows(live: TerminalSnapshot, head: NormalBufferHead): TerminalSnapshot {
  if (head.rowCount === 0) {
    return live
  }
  // Why a screenful of newlines then home: it scrolls every older row into
  // scrollback and leaves the blank, homed screen a fresh live replay expects.
  const prefix = `${head.ansi}${OLDER_ROWS_SEAM}${'\r\n'.repeat(live.rows)}\x1b[H`
  const scrollbackLines = live.scrollbackLines + head.rowCount
  if (live.modes.alternateScreen) {
    // Why links untouched: they index the alt screen, which older rows never enter.
    return { ...live, scrollbackAnsi: prefix + live.scrollbackAnsi, scrollbackLines }
  }
  return {
    ...live,
    snapshotAnsi: prefix + live.snapshotAnsi,
    oscLinks: [
      ...head.oscLinks,
      ...(live.oscLinks ?? []).map((link) => ({ ...link, row: link.row + head.rowCount }))
    ],
    scrollbackLines
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
