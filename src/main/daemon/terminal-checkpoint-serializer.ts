import { clampToSafeSplitIndex } from './daemon-stream-data-split'
import type { TerminalCheckpointFile, TerminalSnapshot } from './types'
import { ColdRestoreReplayWriter } from './cold-restore-replay-writer'
import { HeadlessEmulator } from './headless-emulator'

type CheckpointMetadata = {
  cwd: string | null
  generation: number
  pendingOutputSeq?: number
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
    ...(snapshot.terminalOwner ? { terminalOwner: snapshot.terminalOwner } : {}),
    generation: metadata.generation,
    ...(metadata.pendingOutputSeq !== undefined
      ? { pendingOutputSeq: metadata.pendingOutputSeq }
      : {}),
    checkpointedAt: metadata.checkpointedAt
  }
}

class BoundedJsonWriter {
  private output = ''
  private chunk = ''
  private bytes = 0
  private exceeded = false

  constructor(private readonly maxBytes: number) {}

  append(value: string, bytes: number): boolean {
    if (this.bytes + bytes > this.maxBytes) {
      this.exceeded = true
      this.output = ''
      this.chunk = ''
      return false
    }
    this.bytes += bytes
    this.chunk += value
    if (this.chunk.length >= 16 * 1024) {
      this.output += this.chunk
      this.chunk = ''
    }
    return true
  }

  remainingBytes(): number {
    return this.maxBytes - this.bytes
  }

  result(): string | null {
    return this.exceeded ? null : this.output + this.chunk
  }
}

function appendJsonString(writer: BoundedJsonWriter, value: string): boolean {
  if (!writer.append('"', 1)) {
    return false
  }
  let start = 0
  while (start < value.length) {
    // Keep a surrogate pair together even when only one byte remains.
    const remainingBytes = writer.remainingBytes()
    const chunkLength = remainingBytes < 16 * 1024 ? Math.max(2, remainingBytes) : 16 * 1024
    const end = clampToSafeSplitIndex(value, start, Math.min(value.length, start + chunkLength))
    const json = JSON.stringify(value.slice(start, end)).slice(1, -1)
    if (!writer.append(json, Buffer.byteLength(json, 'utf8'))) {
      return false
    }
    start = end
  }
  return writer.append('"', 1)
}

function omittedByJson(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol'
}

function appendJsonValue(
  writer: BoundedJsonWriter,
  value: unknown,
  activeObjects: Set<object>
): boolean {
  if (value === null) {
    return writer.append('null', 4)
  }
  switch (typeof value) {
    case 'string':
      return appendJsonString(writer, value)
    case 'boolean':
      return writer.append(value ? 'true' : 'false', value ? 4 : 5)
    case 'number': {
      const json = Number.isFinite(value) ? JSON.stringify(value) : 'null'
      return writer.append(json, json.length)
    }
    case 'bigint':
      throw new TypeError('Do not know how to serialize a BigInt')
    case 'undefined':
    case 'function':
    case 'symbol':
      return false
    case 'object':
      break
  }

  if (activeObjects.has(value)) {
    throw new TypeError('Converting circular structure to JSON')
  }
  activeObjects.add(value)
  try {
    if (Array.isArray(value)) {
      if (!writer.append('[', 1)) {
        return false
      }
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0 && !writer.append(',', 1)) {
          return false
        }
        const entry = value[index]
        if (omittedByJson(entry)) {
          if (!writer.append('null', 4)) {
            return false
          }
        } else if (!appendJsonValue(writer, entry, activeObjects)) {
          return false
        }
      }
      return writer.append(']', 1)
    }

    if (!writer.append('{', 1)) {
      return false
    }
    let entries = 0
    for (const key of Object.keys(value)) {
      const entry = (value as Record<string, unknown>)[key]
      if (omittedByJson(entry)) {
        continue
      }
      if (
        (entries > 0 && !writer.append(',', 1)) ||
        !appendJsonString(writer, key) ||
        !writer.append(':', 1) ||
        !appendJsonValue(writer, entry, activeObjects)
      ) {
        return false
      }
      entries += 1
    }
    return writer.append('}', 1)
  } finally {
    activeObjects.delete(value)
  }
}

function stringifyWithinLimit(checkpoint: TerminalCheckpointFile, maxBytes: number): string | null {
  const writer = new BoundedJsonWriter(maxBytes)
  appendJsonValue(writer, checkpoint, new Set())
  return writer.result()
}

/** Rebuilds a snapshot, optionally trimmed to `scrollbackRows` of scrollback. */
export async function replayTerminalSnapshot(
  snapshot: TerminalSnapshot,
  opts: { scrollbackRows?: number } = {}
): Promise<HeadlessEmulator> {
  const scrollbackRows = opts.scrollbackRows ?? snapshot.scrollbackLines
  const emulator = new HeadlessEmulator({
    cols: snapshot.cols,
    rows: snapshot.rows,
    scrollback: Math.max(0, Math.min(50_000, scrollbackRows))
  })
  const replay = new ColdRestoreReplayWriter(emulator)
  const write = async (data: string): Promise<void> => {
    if (!(await replay.write(data))) {
      throw new Error('Terminal checkpoint replay is unavailable')
    }
  }
  try {
    await write(snapshot.scrollbackAnsi)
    await write(snapshot.rehydrateSequences)
    await write(snapshot.snapshotAnsi)
    // Why: rehydrateSequences omits kitty flags, and the torn escape tail must stay last.
    await emulator.applyKittyKeyboardFlags(snapshot.modes.kittyKeyboardFlags ?? 0)
    await write(snapshot.pendingEscapeTailAnsi ?? '')
    emulator.setCwd(snapshot.cwd)
    if (snapshot.lastTitle) {
      emulator.setLastTitle(snapshot.lastTitle)
    }
    // Why untrimmed only: seeded ranges keep pre-trim row indexes; trimmed replays collect the re-emitted OSC 8 instead.
    if (opts.scrollbackRows === undefined) {
      emulator.setRestoredOscLinks(snapshot.oscLinks)
    }
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

  const emulator = await replayTerminalSnapshot(snapshot)
  try {
    // Why carried, not re-derived: trimming rows cannot change who owned the
    // terminal at this checkpoint's boundary.
    const ownership = snapshot.terminalOwner ? { terminalOwner: snapshot.terminalOwner } : {}
    const visibleOnly = { ...emulator.getSnapshot({ scrollbackRows: 0 }), ...ownership }
    let bestJson = stringifyWithinLimit(checkpointFile(visibleOnly, metadata), maxBytes)
    if (bestJson === null) {
      throw new Error('Terminal checkpoint metadata exceeds byte limit')
    }

    let low = 1
    let high = visibleOnly.scrollbackLines
    while (low <= high) {
      const rows = low + Math.floor((high - low) / 2)
      const candidate = { ...emulator.getSnapshot({ scrollbackRows: rows }), ...ownership }
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
