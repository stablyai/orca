import type { TerminalCheckpointFile, TerminalSnapshot } from './types'
import { ColdRestoreReplayWriter } from './cold-restore-replay-writer'
import { HeadlessEmulator } from './headless-emulator'
import { jsonUtf8ByteLength } from './json-utf8-byte-length'

type CheckpointMetadata = {
  cwd: string | null
  generation: number
  checkpointedAt: string
}

function checkpointFile(
  snapshot: TerminalSnapshot,
  metadata: CheckpointMetadata
): TerminalCheckpointFile {
  return {
    snapshotAnsi: snapshot.snapshotAnsi,
    scrollbackAnsi: snapshot.scrollbackAnsi,
    oscLinks: snapshot.oscLinks,
    rehydrateSequences: snapshot.rehydrateSequences,
    ...(snapshot.pendingEscapeTailAnsi
      ? { pendingEscapeTailAnsi: snapshot.pendingEscapeTailAnsi }
      : {}),
    cwd: metadata.cwd,
    cols: snapshot.cols,
    rows: snapshot.rows,
    modes: snapshot.modes,
    scrollbackLines: snapshot.scrollbackLines,
    ...(snapshot.lastTitle ? { lastTitle: snapshot.lastTitle } : {}),
    generation: metadata.generation,
    checkpointedAt: metadata.checkpointedAt
  }
}

function stringifyWithinLimit(checkpoint: TerminalCheckpointFile, maxBytes: number): string | null {
  if (jsonUtf8ByteLength(checkpoint) > maxBytes) {
    return null
  }
  const json = JSON.stringify(checkpoint)
  if (Buffer.byteLength(json, 'utf8') > maxBytes) {
    throw new Error('Terminal checkpoint size estimator mismatch')
  }
  return json
}

async function replaySnapshot(snapshot: TerminalSnapshot): Promise<HeadlessEmulator> {
  const emulator = new HeadlessEmulator({
    cols: snapshot.cols,
    rows: snapshot.rows,
    scrollback: Math.max(0, Math.min(50_000, snapshot.scrollbackLines))
  })
  const replay = new ColdRestoreReplayWriter(emulator)
  try {
    for (const segment of [
      snapshot.scrollbackAnsi,
      snapshot.rehydrateSequences,
      snapshot.snapshotAnsi,
      snapshot.pendingEscapeTailAnsi ?? ''
    ]) {
      if (!(await replay.write(segment))) {
        throw new Error('Terminal checkpoint replay is unavailable')
      }
    }
    emulator.setCwd(snapshot.cwd)
    if (snapshot.lastTitle) {
      emulator.setLastTitle(snapshot.lastTitle)
    }
    emulator.setRestoredOscLinks(snapshot.oscLinks)
    return emulator
  } catch (error) {
    emulator.dispose()
    throw error
  }
}

export async function serializeTerminalCheckpointWithinLimit(
  snapshot: TerminalSnapshot,
  metadata: CheckpointMetadata,
  maxBytes: number
): Promise<string> {
  const direct = stringifyWithinLimit(checkpointFile(snapshot, metadata), maxBytes)
  if (direct !== null) {
    return direct
  }

  const emulator = await replaySnapshot(snapshot)
  try {
    const visibleOnly = emulator.getSnapshot({ scrollbackRows: 0 })
    let bestJson = stringifyWithinLimit(checkpointFile(visibleOnly, metadata), maxBytes)
    if (bestJson === null) {
      throw new Error('Terminal checkpoint metadata exceeds byte limit')
    }

    let low = 1
    let high = visibleOnly.scrollbackLines
    while (low <= high) {
      const rows = low + Math.floor((high - low) / 2)
      const candidate = emulator.getSnapshot({ scrollbackRows: rows })
      const candidateJson = stringifyWithinLimit(checkpointFile(candidate, metadata), maxBytes)
      if (candidateJson === null) {
        high = rows - 1
      } else {
        bestJson = candidateJson
        low = rows + 1
      }
    }
    return bestJson
  } finally {
    emulator.dispose()
  }
}
