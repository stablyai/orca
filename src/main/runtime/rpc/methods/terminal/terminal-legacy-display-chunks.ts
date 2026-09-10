import {
  iterateTerminalOutputFrameChunks,
  type TerminalOutputFrameChunk,
  type TerminalOutputMeta
} from '../../terminal-output-frame-chunks'

export function* iterateLegacyTerminalDisplayChunks(
  data: string,
  meta: TerminalOutputMeta | undefined,
  supportsOutputSpan: boolean
): Generator<TerminalOutputFrameChunk> {
  if (
    supportsOutputSpan ||
    (!meta?.transformed && (meta?.rawLength ?? data.length) === data.length)
  ) {
    yield* iterateTerminalOutputFrameChunks(data, meta)
    return
  }
  // Legacy Output carries display text; source metadata remains owned by replay, not this codec.
  let pending: TerminalOutputFrameChunk | undefined
  for (const chunk of iterateTerminalOutputFrameChunks(data)) {
    if (pending) {
      yield pending
    }
    pending = chunk
  }
  if (pending) {
    // Only the final display chunk can carry the source high-water mark without inventing offsets.
    yield { ...pending, seq: meta?.seq }
  }
}
