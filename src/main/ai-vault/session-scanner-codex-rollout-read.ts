import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { createZstdDecompress, type ZstdDecompress } from 'node:zlib'
import { isCodexCompressedRolloutPath } from './session-scanner-codex-paths'

/**
 * Opens a UTF-8 line stream for a Codex rollout, transparently decompressing
 * cold `*.jsonl.zst` files via Node's built-in zstd support (Node 22.15+ / 24).
 */
export function openCodexRolloutLineStream(filePath: string): Readable {
  const raw = createReadStream(filePath)
  if (!isCodexCompressedRolloutPath(filePath)) {
    return raw
  }
  // Why: Codex cold-compresses rollouts to sibling .jsonl.zst; readers must
  // accept both representations like Codex's open_rollout_line_reader.
  let decoder: ZstdDecompress
  try {
    decoder = createZstdDecompress()
  } catch (error) {
    raw.destroy()
    throw new Error(
      `Zstd decompression is unavailable in this Node runtime; cannot read ${filePath}`,
      { cause: error }
    )
  }
  return raw.pipe(decoder)
}

/** Async-iterable of UTF-8 lines from a plain or zstd Codex rollout. */
export function iterateCodexRolloutLines(
  filePath: string
): AsyncIterable<string> & { close: () => void } {
  const input = openCodexRolloutLineStream(filePath)
  const lines = createInterface({
    input,
    crlfDelay: Infinity
  })
  return {
    [Symbol.asyncIterator]: () => lines[Symbol.asyncIterator](),
    close: () => {
      lines.close()
      input.destroy()
    }
  }
}
