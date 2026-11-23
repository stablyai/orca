import { createReadStream } from 'node:fs'
import type { ProviderRelayRecord } from '../protocol/daemon-provider-relay-protocol'
import type { SpoolFileIndex } from './provider-relay-spool-file-index'

const REPLAY_READ_CHUNK_BYTES = 64 * 1024

type SpoolReplay = {
  path: string
  after: number
  /** False once the attach this replay serves was superseded or the spool disposed. */
  current: () => boolean
  deliver: (record: ProviderRelayRecord) => void
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
      if (isSpoolRecord(record) && record.seq > replay.after) {
        replay.deliver(record)
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

type SpoolFileReplay = SpoolReplay & {
  /**
   * What the file must hold whole. Fewer indexed records than it lists means some were cut or
   * corrupted; rows a failed append left behind are not indexed, and their memory copies are sent.
   */
  index: Pick<SpoolFileIndex, 'has' | 'countAfter'>
}

/**
 * Replays the file part of a spool. 'lost' means it could not be read through, or held fewer
 * records than expected; `highest` is the last seq delivered, so a memory copy is not sent again.
 */
export async function replaySpoolFileRecords(
  replay: SpoolFileReplay
): Promise<{ outcome: 'done' | 'stale' | 'lost'; highest: number }> {
  let highest = replay.after
  let delivered = 0
  const outcome = await replaySpoolFile({
    ...replay,
    deliver: (record) => {
      if (!replay.index.has(record.seq)) {
        return
      }
      highest = Math.max(highest, record.seq)
      delivered++
      replay.deliver(record)
    }
  })
  const expected = replay.index.countAfter(replay.after)
  if (outcome === 'failed' || (outcome === 'done' && delivered < expected)) {
    return { outcome: 'lost', highest }
  }
  return { outcome, highest }
}
