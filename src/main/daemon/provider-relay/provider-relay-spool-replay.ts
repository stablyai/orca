import { createReadStream } from 'node:fs'
import type { ProviderRelayRecord } from '../protocol/daemon-provider-relay-protocol'

const REPLAY_READ_CHUNK_BYTES = 64 * 1024

type SpoolReplay = {
  path: string
  after: number
  /** False once the attach this replay serves was superseded or the spool disposed. */
  current: () => boolean
  deliver: (record: ProviderRelayRecord) => void
  /** Every whole record read, delivered or not, so the caller can tell a cut-short file. */
  seen: (seq: number) => void
  drained?: () => Promise<void>
}

function isSpoolRecord(value: unknown): value is ProviderRelayRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    'seq' in value &&
    Number.isSafeInteger(value.seq) &&
    'line' in value &&
    typeof value.line === 'string'
  )
}

/** 'stale' means the attach was superseded; 'failed' means the file could not be read through. */
export type SpoolReplayOutcome = 'done' | 'stale' | 'failed'

/** Streams a detached spool in chunks, yielding to the client's drain. */
export async function replaySpoolFile(replay: SpoolReplay): Promise<SpoolReplayOutcome> {
  const replayLine = (line: string): void => {
    // A superseded attach sends nothing more, not even rows already read.
    if (line.length === 0 || !replay.current()) {
      return
    }
    try {
      const record: unknown = JSON.parse(line)
      if (isSpoolRecord(record)) {
        replay.seen(record.seq)
        if (record.seq > replay.after) {
          replay.deliver(record)
        }
      }
    } catch {}
  }
  // utf8 decoding keeps a character split across chunks whole.
  const stream = createReadStream(replay.path, {
    encoding: 'utf8',
    highWaterMark: REPLAY_READ_CHUNK_BYTES
  })
  // A record longer than a chunk collects its parts and is joined once, not re-scanned per chunk.
  let parts: string[] = []
  let partial = ''
  try {
    for await (const chunk of stream) {
      if (!chunk.includes('\n')) {
        parts.push(chunk)
        continue
      }
      // The record that ends here is joined alone; it was written, so it fits in one string.
      const newline = chunk.indexOf('\n')
      replayLine(partial + parts.join('') + chunk.slice(0, newline))
      parts = []
      const lines = chunk.slice(newline + 1).split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) {
        replayLine(line)
      }
      await replay.drained?.()
      if (!replay.current()) {
        return 'stale'
      }
    }
    replayLine(partial + parts.join(''))
    return replay.current() ? 'done' : 'stale'
  } catch {
    return replay.current() ? 'failed' : 'stale'
  } finally {
    stream.destroy()
  }
}

type SpoolFileReplay = Omit<SpoolReplay, 'seen'> & {
  /** The highest seq the file should hold whole. */
  fileLast: number
}

/**
 * Replays the file part of a spool. 'lost' means it could not be read through, or ended before
 * `fileLast`; `highest` is the last seq delivered, so a memory copy of it is not sent again.
 */
export async function replaySpoolFileRecords(
  replay: SpoolFileReplay
): Promise<{ outcome: 'done' | 'stale' | 'lost'; highest: number }> {
  let highest = replay.after
  let seen = 0
  const outcome = await replaySpoolFile({
    ...replay,
    deliver: (record) => {
      highest = Math.max(highest, record.seq)
      replay.deliver(record)
    },
    seen: (seq) => {
      seen = Math.max(seen, seq)
    }
  })
  if (outcome === 'failed' || (outcome === 'done' && seen < replay.fileLast)) {
    return { outcome: 'lost', highest }
  }
  return { outcome, highest }
}
