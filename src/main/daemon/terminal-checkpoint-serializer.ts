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

  result(): string | null {
    return this.exceeded ? null : this.output + this.chunk
  }
}

function escapedCodeUnit(codeUnit: number): string | null {
  switch (codeUnit) {
    case 0x08:
      return '\\b'
    case 0x09:
      return '\\t'
    case 0x0a:
      return '\\n'
    case 0x0c:
      return '\\f'
    case 0x0d:
      return '\\r'
    case 0x22:
      return '\\"'
    case 0x5c:
      return '\\\\'
    default:
      return codeUnit < 0x20 ? `\\u${codeUnit.toString(16).padStart(4, '0')}` : null
  }
}

function appendJsonString(writer: BoundedJsonWriter, value: string): boolean {
  if (!writer.append('"', 1)) {
    return false
  }
  let spanStart = 0
  let spanBytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    let escaped = escapedCodeUnit(codeUnit)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        spanBytes += 4
        index += 1
      } else {
        escaped = `\\u${codeUnit.toString(16)}`
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      escaped = `\\u${codeUnit.toString(16)}`
    } else if (escaped === null) {
      spanBytes += codeUnit < 0x80 ? 1 : codeUnit < 0x800 ? 2 : 3
    }

    if (escaped !== null) {
      if (
        (index > spanStart && !writer.append(value.slice(spanStart, index), spanBytes)) ||
        !writer.append(escaped, escaped.length)
      ) {
        return false
      }
      spanStart = index + 1
      spanBytes = 0
    } else if (index + 1 - spanStart >= 16 * 1024) {
      if (!writer.append(value.slice(spanStart, index + 1), spanBytes)) {
        return false
      }
      spanStart = index + 1
      spanBytes = 0
    }
  }
  if (spanStart < value.length && !writer.append(value.slice(spanStart), spanBytes)) {
    return false
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
