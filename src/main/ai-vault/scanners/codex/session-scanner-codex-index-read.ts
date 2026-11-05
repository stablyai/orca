import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import {
  openTranscriptReadStream,
  readTranscriptSlice
} from '../../../native-chat/wsl-transcript-fs-access'
import { consumeCompleteJsonlLines } from '../../session-scanner-jsonl-reader'
import { extractString, parseJsonObject } from '../../session-scanner-values'
import { normalizeTitleText } from '../../session-scanner-text-normalization'

export type CodexIndexRead = {
  titles: Map<string, string>
  offset: number
  readThrough: number
  dev: number
  ino: number
  firstRecord: { length: number; hash: string } | null
}

async function firstRecordSignature(path: string, end: number) {
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

export async function readCodexIndexUpdate(
  path: string,
  stat: Stats,
  previous?: CodexIndexRead
): Promise<CodexIndexRead> {
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
  const titles = append ? new Map(previous!.titles) : new Map<string, string>()
  const applyLine = (line: string) => {
    const record = parseJsonObject(line)
    const sessionId = record && extractString(record.id)
    const title = record && normalizeTitleText(extractString(record.thread_name) ?? '')
    if (sessionId && title) {
      titles.set(sessionId, title)
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
  return {
    titles,
    offset: consumedThrough,
    readThrough: start + bytesRead,
    dev: stat.dev,
    ino: stat.ino,
    firstRecord: append
      ? previous!.firstRecord
      : consumedThrough > 0
        ? await firstRecordSignature(path, consumedThrough)
        : null
  }
}
