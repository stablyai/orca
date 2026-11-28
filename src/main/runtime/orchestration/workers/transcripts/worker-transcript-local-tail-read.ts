import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import {
  readNativeChatTranscriptTailFile,
  type NativeChatLineDecoder
} from '../../../../native-chat/transcript-tail-reader'
import type { nativeChatTurnEvidenceObserverForAgent } from '../../../../native-chat/transcript-decoding/transcript-turn-evidence'
import {
  readLocalTranscriptPathBoundaryCheckpoint,
  readLocalTranscriptSourceIdentity
} from './worker-transcript-local-checkpoint'
import { workerTranscriptSourceChanged } from './worker-transcript-source-identity'
import {
  MAX_TRANSCRIPT_SCAN_BYTES,
  recordWarnings,
  sourceChanged,
  type LocalTranscriptReadResult,
  type WorkerTranscriptOlderBoundary
} from './worker-transcript-local-read'

type TailPage = Awaited<ReturnType<typeof readNativeChatTranscriptTailFile>>

/** `backward` scans one bounded window and reports where the next older page ends; messages
 *  `keep` leaves out of the response stay for that page. */
export async function readTailLocalWorkerTranscriptPage(
  filePath: string,
  args: {
    limit: number
    decode: NativeChatLineDecoder
    turnObserver: ReturnType<typeof nativeChatTurnEvidenceObserverForAgent>
    keep: (messages: readonly NativeChatMessage[]) => number
    backward?: { endingAt?: WorkerTranscriptOlderBoundary }
  }
): Promise<LocalTranscriptReadResult> {
  const before = await readLocalTranscriptSourceIdentity(filePath)
  if (!before) {
    return { ok: false, reason: 'transcript_unreadable', warnings: [] }
  }
  const endingAt = args.backward?.endingAt
  // A same-size rewrite or a shrink since issuance keeps the inode but not the older bytes.
  if (
    endingAt &&
    workerTranscriptSourceChanged(
      { ...before, size: endingAt.sourceSize, mtimeMs: endingAt.sourceMtimeMs },
      before,
      endingAt.offset
    )
  ) {
    return sourceChanged()
  }
  const page = await readNativeChatTranscriptTailFile(
    filePath,
    args.limit,
    args.decode,
    false,
    // A backward page reads the snapshot its cursor records, so a concurrent append can't put the
    // kept start past the recorded size.
    endingAt?.offset ?? (args.backward ? before.size : undefined),
    null,
    undefined,
    undefined,
    false,
    args.turnObserver?.observe,
    args.backward ? MAX_TRANSCRIPT_SCAN_BYTES : undefined
  )
  const after = await readLocalTranscriptSourceIdentity(filePath)
  // A record start ends a page exactly there; only an offset inside a record ends lower.
  if (
    (endingAt && !endingAt.insideRecord && page.consumedTo !== endingAt.offset) ||
    workerTranscriptSourceChanged(before, after, page.consumedTo)
  ) {
    return sourceChanged()
  }
  const boundaryCheckpoint = await readLocalTranscriptPathBoundaryCheckpoint(
    filePath,
    before,
    page.consumedTo
  )
  const endCheckpoint =
    endingAt && page.consumedTo !== endingAt.offset
      ? await readLocalTranscriptPathBoundaryCheckpoint(filePath, before, endingAt.offset)
      : boundaryCheckpoint
  if (!boundaryCheckpoint || (endingAt && endCheckpoint !== endingAt.boundaryCheckpoint)) {
    return sourceChanged()
  }
  const dropped = page.messages.length - args.keep(page.messages)
  const olderEdge = args.backward ? olderPageEdge(page, dropped) : null
  let older: WorkerTranscriptOlderBoundary | null = null
  if (olderEdge) {
    const checkpoint = await readLocalTranscriptPathBoundaryCheckpoint(
      filePath,
      before,
      olderEdge.offset
    )
    if (!checkpoint) {
      return sourceChanged()
    }
    older = {
      ...olderEdge,
      boundaryCheckpoint: checkpoint,
      sourceSize: before.size,
      sourceMtimeMs: before.mtimeMs
    }
  }
  const turn =
    page.malformedRecordCount || page.oversizedRecordCount
      ? undefined
      : args.turnObserver?.result(page.messageOffsets)
  return {
    ok: true,
    filePath,
    sourceFingerprint: before.fingerprint,
    boundaryCheckpoint,
    messages: page.messages,
    nextOffset: page.consumedTo,
    limited: args.backward ? older !== null : page.hasMore,
    clipping: [],
    warnings: recordWarnings(page.malformedRecordCount, page.oversizedRecordCount),
    ...(turn ? { turn } : {}),
    ...(args.backward ? { older } : {})
  }
}

/** Where the next older page ends, strictly below this one's end; null once the file start was
 *  read and nothing was dropped. */
function olderPageEdge(
  page: TailPage,
  dropped: number
): Pick<WorkerTranscriptOlderBoundary, 'offset' | 'insideRecord'> | null {
  const { end, floor, oldestLineStart } = page.scan ?? { end: 0, floor: 0, oldestLineStart: 0 }
  // The oldest kept message: dropped and unscanned older messages stay for the next page.
  if (page.hasMore || dropped > 0 || (page.messages.length > 0 && oldestLineStart !== 0)) {
    return { offset: page.messageOffsets[dropped]! }
  }
  if (oldestLineStart === 0) {
    return null
  }
  // A window with no message: continue below its oldest complete line, so a record crossing the
  // floor is read whole next time.
  if (oldestLineStart !== null) {
    return { offset: oldestLineStart }
  }
  if (page.consumedTo > floor && page.consumedTo < end) {
    return { offset: page.consumedTo }
  }
  // No line starts in the window: one record longer than it, skipped one window per read.
  return { offset: floor, insideRecord: true }
}
