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
  recordWarnings,
  sourceChanged,
  type LocalTranscriptReadResult,
  type WorkerTranscriptOlderBoundary
} from './worker-transcript-local-read'

/** The newest `limit` messages, of the file or (with `endingAt`) of the bytes before a prior
 *  page's older boundary. `keep` says how many of the newest fit the response; the older boundary
 *  is the oldest kept message's start, so messages the response drops stay for the next page. */
export async function readTailLocalWorkerTranscriptPage(
  filePath: string,
  args: {
    limit: number
    decode: NativeChatLineDecoder
    turnObserver: ReturnType<typeof nativeChatTurnEvidenceObserverForAgent>
    keep: (messages: readonly NativeChatMessage[]) => number
    endingAt?: WorkerTranscriptOlderBoundary
  }
): Promise<LocalTranscriptReadResult> {
  const before = await readLocalTranscriptSourceIdentity(filePath)
  if (!before) {
    return { ok: false, reason: 'transcript_unreadable', warnings: [] }
  }
  const end = args.endingAt?.offset
  if (end !== undefined && before.size < end) {
    return sourceChanged()
  }
  const page = await readNativeChatTranscriptTailFile(
    filePath,
    args.limit,
    args.decode,
    false,
    end,
    null,
    undefined,
    undefined,
    false,
    args.turnObserver?.observe
  )
  const after = await readLocalTranscriptSourceIdentity(filePath)
  // A boundary is a record start, so a page ending there consumes exactly up to it.
  if (
    (end !== undefined && page.consumedTo !== end) ||
    workerTranscriptSourceChanged(before, after, page.consumedTo)
  ) {
    return sourceChanged()
  }
  const boundaryCheckpoint = await readLocalTranscriptPathBoundaryCheckpoint(
    filePath,
    before,
    page.consumedTo
  )
  if (
    !boundaryCheckpoint ||
    (args.endingAt && boundaryCheckpoint !== args.endingAt.boundaryCheckpoint)
  ) {
    return sourceChanged()
  }
  const dropped = page.messages.length - args.keep(page.messages)
  const olderOffset = page.hasMore || dropped > 0 ? page.messageOffsets[dropped] : undefined
  let older: WorkerTranscriptOlderBoundary | null = null
  if (olderOffset !== undefined) {
    const checkpoint = await readLocalTranscriptPathBoundaryCheckpoint(
      filePath,
      before,
      olderOffset
    )
    if (!checkpoint) {
      return sourceChanged()
    }
    older = { offset: olderOffset, boundaryCheckpoint: checkpoint }
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
    limited: page.hasMore,
    clipping: [],
    warnings: recordWarnings(page.malformedRecordCount, page.oversizedRecordCount),
    ...(turn ? { turn } : {}),
    older
  }
}
