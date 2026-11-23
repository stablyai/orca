import { createReadStream } from 'node:fs'
import type { ProviderRelayRecord } from '../protocol/daemon-provider-relay-protocol'

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

/** Streams a detached spool in chunks, yielding to the client's drain; false when the attach went stale. */
export async function replaySpoolFile(replay: SpoolReplay): Promise<boolean> {
  const replayLine = (line: string): void => {
    if (line.length === 0) {
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
        return false
      }
    }
    replayLine(partial + parts.join(''))
    return true
  } catch {
    return replay.current()
  } finally {
    stream.destroy()
  }
}
