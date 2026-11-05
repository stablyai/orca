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
  size: number
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
    stat.size > previous.size &&
    (!(stat.dev && stat.ino && previous.dev && previous.ino) ||
      (stat.dev === previous.dev && stat.ino === previous.ino))
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
  const { consumedThrough } = await consumeCompleteJsonlLines({
    path,
    start: append ? previous!.offset : 0,
    onLine: (line) => {
      const record = parseJsonObject(line)
      const sessionId = record && extractString(record.id)
      const title = record && normalizeTitleText(extractString(record.thread_name) ?? '')
      if (sessionId && title) {
        titles.set(sessionId, title)
      }
    }
  })
  return {
    titles,
    offset: consumedThrough,
    size: stat.size,
    dev: stat.dev,
    ino: stat.ino,
    firstRecord: append
      ? previous!.firstRecord
      : consumedThrough > 0
        ? await firstRecordSignature(path, consumedThrough)
        : null
  }
}
