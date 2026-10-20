import type { NativeChatMessage, NativeChatTurnLifecycle } from '../../shared/native-chat-types'
import { resolveCodexRolloutLineage } from '../codex/codex-rollout-lineage'
import { decodeTranscriptStream } from './transcript-stream-lines'
import { openTranscriptReadStream, transcriptFileStat } from './wsl-transcript-fs-access'

type LineDecoder = (line: string, fallbackId: string) => NativeChatMessage | null

/** One file's slice of the conversation: bytes [0, length) of `path` sit at `start`. */
export type CodexTranscriptSegment = { path: string; start: number; length: number | null }

/**
 * A reverted or forked Codex rollout holds only its own turns; the rest is the
 * `history_base` prefixes it inherits. Lays them out as one byte space — oldest
 * prefix first, the rollout itself last (open-ended, null length) — so a numeric
 * cursor keeps paging across them. A single segment means nothing is inherited.
 */
export async function codexTranscriptSegments(
  filePath: string,
  signal?: AbortSignal
): Promise<CodexTranscriptSegment[]> {
  const lineage = await resolveCodexRolloutLineage(filePath, 'exact', signal)
  const segments: CodexTranscriptSegment[] = []
  let start = 0
  for (const ancestor of lineage.ancestors) {
    segments.push({ path: ancestor.path, start, length: ancestor.endByteOffset })
    start += ancestor.endByteOffset
  }
  segments.push({ path: filePath, start, length: null })
  return segments
}

export async function readCodexTranscriptSegments(
  segments: readonly CodexTranscriptSegment[],
  decode: LineDecoder
): Promise<NativeChatMessage[]> {
  const messages: NativeChatMessage[] = []
  for (const segment of segments) {
    if (segment.length === 0) {
      continue
    }
    const stream = openTranscriptReadStream(
      segment.path,
      // `end` is inclusive; a prefix ends at the first byte not inherited.
      { encoding: 'utf-8', ...(segment.length === null ? {} : { end: segment.length - 1 }) },
      'exact'
    )
    messages.push(...(await decodeTranscriptStream(stream, segment.path, 0, decode, true)).messages)
  }
  return messages
}

type TailPage = {
  messages: NativeChatMessage[]
  lifecycle?: NativeChatTurnLifecycle
  hasMore: boolean
  beforeOffset: number
}

/**
 * Newest-first paging over several segments. `readTail(path, limit, endOffset,
 * withLifecycle)` reads one file's tail; only the live file's tail may report
 * turn state, and only on the first page.
 */
export async function readCodexTranscriptSegmentsTail(args: {
  segments: readonly CodexTranscriptSegment[]
  limit: number
  beforeOffset?: number
  readTail: (
    path: string,
    limit: number,
    endOffset: number,
    withLifecycle: boolean
  ) => Promise<TailPage>
  signal?: AbortSignal
}): Promise<TailPage> {
  const { segments } = args
  const current = segments.at(-1)
  if (!current) {
    return { messages: [], hasMore: false, beforeOffset: 0 }
  }
  const currentLength = (await transcriptFileStat(current.path, 'exact', args.signal)).size
  let cursor = args.beforeOffset ?? current.start + currentLength
  const pages: NativeChatMessage[][] = []
  let collected = 0
  let lifecycle: NativeChatTurnLifecycle | undefined
  let hasMore = false
  for (let index = segments.length - 1; index >= 0 && collected < args.limit; index -= 1) {
    const segment = segments[index]
    if (cursor <= segment.start) {
      continue
    }
    const page = await args.readTail(
      segment.path,
      args.limit - collected,
      Math.min(cursor - segment.start, segment.length ?? Number.MAX_SAFE_INTEGER),
      segment === current && args.beforeOffset === undefined
    )
    lifecycle ??= page.lifecycle
    pages.unshift(page.messages)
    collected += page.messages.length
    // An exhausted segment hands the cursor to the older one before it.
    cursor = page.hasMore ? segment.start + page.beforeOffset : segment.start
    hasMore = page.hasMore || index > 0
    if (page.hasMore) {
      break
    }
  }
  return {
    messages: pages.flat(),
    ...(lifecycle ? { lifecycle } : {}),
    hasMore: hasMore && cursor > 0,
    beforeOffset: cursor
  }
}
