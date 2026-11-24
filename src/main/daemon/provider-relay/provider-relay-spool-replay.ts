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
      // Checked per chunk, so a reader superseded while stalled stops at once rather than at a newline.
      if (!replay.current()) {
        return 'stale'
      }
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
      // A stale reader never waits on the replacement client's socket.
      if (!replay.current()) {
        return 'stale'
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
    // Settles only once the fd is closed, so the next reader never opens beside this one.
    if (!stream.closed) {
      const closed = new Promise((resolve) => stream.once('close', resolve))
      stream.destroy()
      await closed
    }
  }
}

type SpoolFileReplay = SpoolReplay & {
  /**
   * What the file must hold whole, read live, since acks remove entries as they land. Rows a
   * failed append left behind are not indexed; their memory copies are sent instead.
   */
  index: Pick<SpoolFileIndex, 'has' | 'countAfter' | 'ackedThrough'>
}

/**
 * Replays the file part of a spool; `highest` is the last seq sent, so a memory copy is not sent
 * again. 'lost' means a record the client still needs was not sent: the file was unreadable, cut
 * short or corrupt there.
 */
export async function replaySpoolFileRecords(
  replay: SpoolFileReplay
): Promise<{ outcome: 'done' | 'stale' | 'lost'; highest: number }> {
  let highest = replay.after
  const sent: number[] = []
  const outcome = await replaySpoolFile({
    ...replay,
    deliver: (record) => {
      // Only rising seqs the index still lists are sent, so a duplicate or stray row can't stand in for a missing one.
      if (record.seq <= highest || !replay.index.has(record.seq)) {
        return
      }
      highest = record.seq
      sent.push(record.seq)
      replay.deliver(record)
    }
  })
  if (outcome === 'stale') {
    return { outcome, highest }
  }
  // Judged once the replay ends, against what is still unacked, so an ack meanwhile is never a loss.
  const owedAfter = Math.max(replay.after, replay.index.ackedThrough)
  const sentOwed = sent.filter((seq) => seq > owedAfter).length
  return { outcome: sentOwed < replay.index.countAfter(owedAfter) ? 'lost' : 'done', highest }
}

type MemoryTailReplay = {
  /** Read live: an ack may compact memory into a new array while a drain wait is pending. */
  memory: () => readonly ProviderRelayRecord[]
  head: number
  after: number
  current: () => boolean
  deliver: (record: ProviderRelayRecord) => void
  drained?: () => Promise<void>
  /** Runs synchronously with the check that found nothing left, before the promise settles. */
  caughtUp: () => void
}

/** Sends memory records after `after`, waiting for the socket after each; null once superseded. */
export async function replayMemoryTail(replay: MemoryTailReplay): Promise<number | null> {
  let { after } = replay
  let memory = replay.memory()
  let index = replay.head
  while (true) {
    // Checked before the bounds test: a compaction during the wait shortens the array.
    if (memory !== replay.memory()) {
      memory = replay.memory()
      const at = memory.findIndex((record) => record.seq > after)
      index = at === -1 ? memory.length : at
    }
    if (index >= memory.length) {
      replay.caughtUp()
      return after
    }
    const record = memory[index++]
    if (record.seq <= after) {
      continue
    }
    replay.deliver(record)
    after = record.seq
    if (!replay.current()) {
      return null
    }
    await replay.drained?.()
    if (!replay.current()) {
      return null
    }
  }
}
