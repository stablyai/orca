import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { compose, type Readable } from 'node:stream'
import { createZstdDecompress, type ZstdDecompress } from 'node:zlib'
import { isCodexCompressedRolloutPath } from './session-scanner-codex-paths'

/** Opens a UTF-8 stream for either a plain or cold-compressed Codex rollout. */
export function openCodexRolloutStream(filePath: string): Readable {
  const raw = createReadStream(filePath)
  if (!isCodexCompressedRolloutPath(filePath)) {
    return raw
  }

  // Why: Codex cold-compresses rollouts to `.jsonl.zst`; readers must accept
  // both forms without loading the entire transcript into memory.
  let decoder: ZstdDecompress
  try {
    decoder = createZstdDecompress()
  } catch (error) {
    raw.destroy()
    throw new Error(`Zstd decompression is unavailable; cannot read ${filePath}`, {
      cause: error
    })
  }
  // `compose` owns the complete source→decoder pipeline: source errors reach
  // readers, and destroying the returned stream tears down both resources.
  return compose(raw, decoder)
}

/** Async lines plus an explicit close hook for early worker-session rejection. */
export function iterateCodexRolloutLines(
  filePath: string
): AsyncIterable<string> & { close: () => void } {
  const input = openCodexRolloutStream(filePath)
  const lines = createInterface({ input, crlfDelay: Infinity })
  return {
    [Symbol.asyncIterator]: () => lines[Symbol.asyncIterator](),
    close: () => {
      lines.close()
      // Early worker-session rejection intentionally aborts the composed zstd
      // pipeline; consume that close-only AbortError after parsing has stopped.
      input.once('error', () => undefined)
      input.destroy()
    }
  }
}
