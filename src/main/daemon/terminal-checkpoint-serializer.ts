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

/** Tracks how many UTF-8 bytes `JSON.stringify` would emit. `add` returning false unwinds the
 *  whole walk, so an over-limit checkpoint is abandoned partway instead of measured whole. */
class JsonByteBudget {
  private bytes = 0

  constructor(private readonly maxBytes: number) {}

  remaining(): number {
    return this.maxBytes - this.bytes
  }

  add(bytes: number): boolean {
    this.bytes += bytes
    return this.bytes <= this.maxBytes
  }
}

const MEASURE_CHUNK_CODE_UNITS = 8 * 1024

function measureJsonString(budget: JsonByteBudget, value: string): boolean {
  const remaining = budget.remaining()
  let bytes = 2
  let index = 0
  // Why: test the budget per chunk, not per code unit — a multi-megabyte scrollback still
  // bails within one chunk of going over, without paying a compare on every character.
  while (index < value.length) {
    const chunkEnd = Math.min(value.length, index + MEASURE_CHUNK_CODE_UNITS)
    for (; index < chunkEnd; index += 1) {
      const codeUnit = value.charCodeAt(index)
      if (codeUnit === 0x22 || codeUnit === 0x5c) {
        bytes += 2
      } else if (codeUnit < 0x20) {
        bytes +=
          codeUnit === 0x08 ||
          codeUnit === 0x09 ||
          codeUnit === 0x0a ||
          codeUnit === 0x0c ||
          codeUnit === 0x0d
            ? 2
            : 6
      } else if (codeUnit < 0x80) {
        bytes += 1
      } else if (codeUnit < 0x800) {
        bytes += 2
      } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        const next = value.charCodeAt(index + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4
          index += 1
        } else {
          bytes += 6
        }
      } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        bytes += 6
      } else {
        bytes += 3
      }
    }
    if (bytes > remaining) {
      return budget.add(bytes)
    }
  }
  return budget.add(bytes)
}

function omittedByJson(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol'
}

function measureJsonValue(
  budget: JsonByteBudget,
  value: unknown,
  activeObjects: Set<object>
): boolean {
  if (value === null) {
    return budget.add(4)
  }
  switch (typeof value) {
    case 'string':
      return measureJsonString(budget, value)
    case 'boolean':
      return budget.add(value ? 4 : 5)
    case 'number':
      return budget.add(Number.isFinite(value) ? JSON.stringify(value).length : 4)
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
      // Why: both brackets are charged up front — the running total only has to be right at
      // the end, and pre-charging the closer keeps the exit paths from having to add it.
      if (!budget.add(2)) {
        return false
      }
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0 && !budget.add(1)) {
          return false
        }
        // Why: JSON.stringify renders holes and non-serializable elements as null.
        const entry = value[index]
        const fits = omittedByJson(entry)
          ? budget.add(4)
          : measureJsonValue(budget, entry, activeObjects)
        if (!fits) {
          return false
        }
      }
      return true
    }

    if (!budget.add(2)) {
      return false
    }
    let entries = 0
    for (const key of Object.keys(value)) {
      const entry = (value as Record<string, unknown>)[key]
      if (omittedByJson(entry)) {
        continue
      }
      if (
        (entries > 0 && !budget.add(1)) ||
        !measureJsonString(budget, key) ||
        !budget.add(1) ||
        !measureJsonValue(budget, entry, activeObjects)
      ) {
        return false
      }
      entries += 1
    }
    return true
  } finally {
    activeObjects.delete(value)
  }
}

function stringifyWithinLimit(checkpoint: TerminalCheckpointFile, maxBytes: number): string | null {
  // Why: size the checkpoint first so an over-cap payload is never handed to JSON.stringify,
  // then let the native serializer emit the JSON — it is far faster than emitting it by hand.
  if (!measureJsonValue(new JsonByteBudget(maxBytes), checkpoint, new Set())) {
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
