import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import {
  openTranscriptReadStream,
  readTranscriptSlice
} from '../native-chat/wsl-transcript-fs-access'
import { consumeCompleteJsonlLines } from './session-scanner-jsonl-reader'

export type SessionIndexJsonlRead = {
  values: Map<string, string>
  changedKeys: ReadonlySet<string>
  offset: number
  readThrough: number
  dev: number
  ino: number
  firstRecord: { length: number; hash: string } | null
}

export async function firstRecordSignature(path: string, end: number) {
  const hash = createHash('sha256')
  let length = 0
  for await (const chunk of openTranscriptReadStream(path, { end: end - 1 }, 'scan')) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const newline = bytes.indexOf(0x0a)
    const prefix = newline === -1 ? bytes : bytes.subarray(0, newline + 1)
    hash.update(prefix)
    length += prefix.length
    if (newline !== -1) {
      return { length, hash: hash.digest('hex') }
    }
  }
  return null
}

export type SessionIndexJsonlCursor = Omit<SessionIndexJsonlRead, 'values' | 'changedKeys'>

export async function canAppendSessionIndexJsonl(
  path: string,
  stat: Stats,
  previous: SessionIndexJsonlCursor | undefined
): Promise<boolean> {
  let append = false
  if (
    previous?.firstRecord &&
    previous.offset === previous.readThrough &&
    stat.size > previous.readThrough &&
    stat.dev !== 0 &&
    stat.ino !== 0 &&
    previous.dev !== 0 &&
    previous.ino !== 0 &&
    stat.dev === previous.dev &&
    stat.ino === previous.ino
  ) {
    try {
      const prefix = await firstRecordSignature(path, previous.firstRecord.length)
      const boundary = await readTranscriptSlice(path, previous.offset - 1, 1, 'scan')
      // Growth alone cannot distinguish an append from Codex replacing the index on removal.
      append = prefix?.hash === previous.firstRecord.hash && boundary[0] === 0x0a
    } catch {
      // A failed continuity check requires a complete reread.
    }
  }
  return append
}

export async function readSessionIndexJsonl(
  path: string,
  stat: Stats,
  previous: SessionIndexJsonlRead | undefined,
  parse: (line: string) => readonly [string, string] | null
): Promise<SessionIndexJsonlRead> {
  const append = await canAppendSessionIndexJsonl(path, stat, previous)
  const updates = new Map<string, string>()
  const applyLine = (line: string) => {
    const entry = parse(line)
    if (entry) {
      updates.set(entry[0], entry[1])
    }
  }
  const start = append ? previous!.offset : 0
  const { consumedThrough, trailingPartialLine, bytesRead } = await consumeCompleteJsonlLines({
    path,
    start,
    onLine: applyLine
  })
  // EOF JSON remains readable; a tail forces the next growth to reread rather than retain it.
  if (trailingPartialLine) {
    applyLine(trailingPartialLine)
  }
  const firstRecord = append
    ? previous!.firstRecord
    : consumedThrough > 0
      ? await firstRecordSignature(path, consumedThrough)
      : null
  const values = append ? previous!.values : new Map<string, string>()
  const changedKeys = new Set<string>()
  for (const [key, value] of updates) {
    if (previous?.values.get(key) !== value) {
      changedKeys.add(key)
    }
    values.set(key, value)
  }
  if (!append) {
    for (const key of previous?.values.keys() ?? []) {
      if (!values.has(key)) {
        changedKeys.add(key)
      }
    }
  }
  return {
    values,
    changedKeys,
    offset: consumedThrough,
    readThrough: start + bytesRead,
    dev: stat.dev,
    ino: stat.ino,
    firstRecord
  }
}
