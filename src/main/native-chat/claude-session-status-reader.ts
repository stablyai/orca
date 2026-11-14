import { open } from 'node:fs/promises'
import { BoundedMap } from '../../shared/bounded-map'
import type { ClaudeSessionStatusFacts } from '../../shared/native-chat/claude-session-status'
import {
  applyClaudeSessionStatusLine,
  emptyClaudeSessionStatusFacts
} from './claude-session-status-lines'

const READ_CHUNK_BYTES = 64 * 1024
/** A longer line is not a status row; it is dropped instead of being buffered. */
export const MAX_CLAUDE_SESSION_STATUS_LINE_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_FILES = 64
const NEWLINE = 0x0a

type TrackedFile = {
  /** Device and inode: a file replaced at the same path is read again from the start. */
  identity: string
  offset: number
  partial: Buffer[]
  partialBytes: number
  skippingOversizedLine: boolean
  facts: ClaudeSessionStatusFacts
}

function trackFile(identity: string): TrackedFile {
  return {
    identity,
    offset: 0,
    partial: [],
    partialBytes: 0,
    skippingOversizedLine: false,
    facts: emptyClaudeSessionStatusFacts()
  }
}

function holdPartialLine(file: TrackedFile, bytes: Buffer): void {
  if (file.skippingOversizedLine) {
    return
  }
  if (file.partialBytes + bytes.length > MAX_CLAUDE_SESSION_STATUS_LINE_BYTES) {
    file.skippingOversizedLine = true
    file.partial = []
    file.partialBytes = 0
    return
  }
  file.partial.push(Buffer.from(bytes))
  file.partialBytes += bytes.length
}

function finishLine(file: TrackedFile): void {
  if (!file.skippingOversizedLine) {
    applyClaudeSessionStatusLine(file.facts, Buffer.concat(file.partial).toString('utf8'))
  }
  file.partial = []
  file.partialBytes = 0
  file.skippingOversizedLine = false
}

function consumeBytes(file: TrackedFile, bytes: Buffer): void {
  let start = 0
  while (start <= bytes.length) {
    const newline = bytes.indexOf(NEWLINE, start)
    if (newline === -1) {
      holdPartialLine(file, bytes.subarray(start))
      return
    }
    holdPartialLine(file, bytes.subarray(start, newline))
    finishLine(file)
    start = newline + 1
  }
}

/** Follows Claude session files by offset, so a long session is read once in full. */
export function createClaudeSessionStatusReader(maxFiles = DEFAULT_MAX_FILES): {
  read(filePath: string, signal?: AbortSignal): Promise<ClaudeSessionStatusFacts | null>
} {
  const files = new BoundedMap<string, TrackedFile>({ maxEntries: maxFiles })
  const inFlight = new Map<string, Promise<unknown>>()

  async function advance(
    filePath: string,
    signal: AbortSignal | undefined
  ): Promise<ClaudeSessionStatusFacts | null> {
    let handle
    try {
      handle = await open(filePath, 'r')
    } catch {
      files.delete(filePath)
      return null
    }
    try {
      // Bigint keeps device and inode numbers past 2^53 distinct.
      const stats = await handle.stat({ bigint: true })
      const size = Number(stats.size)
      const identity = `${stats.dev}:${stats.ino}`
      let file = files.get(filePath)
      if (!file || file.identity !== identity || size < file.offset) {
        file = trackFile(identity)
        files.set(filePath, file)
      }
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
      while (file.offset < size && !signal?.aborted) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, file.offset)
        if (bytesRead === 0) {
          break
        }
        consumeBytes(file, buffer.subarray(0, bytesRead))
        file.offset += bytesRead
      }
      return { ...file.facts }
    } catch {
      return null
    } finally {
      await handle.close()
    }
  }

  return {
    // Reads of one file run in turn: overlapping ones would apply the same bytes twice.
    read(filePath, signal) {
      const previous = inFlight.get(filePath) ?? Promise.resolve()
      const current = previous.then(() => advance(filePath, signal))
      inFlight.set(filePath, current)
      void current.finally(() => {
        if (inFlight.get(filePath) === current) {
          inFlight.delete(filePath)
        }
      })
      return current
    }
  }
}
