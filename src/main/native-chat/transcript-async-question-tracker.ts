// Per-subscription host derivation of pending Codex async questions for one watched
// rollout. Reconstruction runs backward from the snapshot's consumed-byte boundary, or
// only over the bytes written since a cached fold of the same file; lines appended past
// that boundary meanwhile are buffered and folded after it, in file order, so a live
// subscriber and a fresh one derive the same set from the same file. Until reconstruction
// finishes the published state is `pending`, never partial; after a failed read it is
// `absent` (as with an old host) until a retry the watcher drives succeeds.

import {
  createNativeChatAsyncQuestionFoldState,
  foldNativeChatAsyncQuestionFact,
  nativeChatAsyncQuestionsFieldsEqual,
  nativeChatAsyncQuestionsFromFold,
  publishNativeChatAsyncQuestions,
  type NativeChatAsyncQuestionFact,
  type NativeChatAsyncQuestionFoldState,
  type NativeChatAsyncQuestionsField
} from '../../shared/native-chat-async-questions'
import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat-agent-support'
import {
  codexOversizedRolloutRecordFacts,
  codexRolloutAsyncQuestionFacts
} from './codex-rollout-async-question-facts'
import { boundaryFingerprint, type TranscriptFileVersion } from './transcript-file-version'
import {
  recallTranscriptAsyncQuestionFold,
  rememberTranscriptAsyncQuestionFold,
  type RecalledTranscriptAsyncQuestionFold,
  type TranscriptAsyncQuestionFoldMark
} from './transcript-async-question-fold-cache'
import type {
  IncrementalTranscriptState,
  OversizedTranscriptRecordObserver
} from './transcript-incremental-reader'
import type { SubscribeNativeChatTranscriptArgs } from './transcript-watch-contract'
import type { NativeChatLineDecoder } from './transcript-tail-reader'
import { scanCodexAsyncQuestionFactsBefore } from './transcript-async-question-boundary-scan'

export type TranscriptAsyncQuestionTracker = {
  /** Reconstruct the set before `endOffset`; lines observed afterwards start at it. */
  begin: (endOffset: number, version: TranscriptFileVersion) => void
  /** Restart as a forward read from the start of the file (complete by construction). */
  beginFromStart: () => void
  /** Feed one line read at or past the boundary, in file order. */
  observeLine: (line: string, recordId: string) => void
  /** Feed the head of a line too large to read, in file order. */
  observeOversizedRecord: OversizedTranscriptRecordObserver
  /** The field to publish now. */
  field: () => NativeChatAsyncQuestionsField
  /** The field if it changed since the last call to this or `markPublished`, else undefined. */
  takeChanged: () => NativeChatAsyncQuestionsField | undefined
  markPublished: (field: NativeChatAsyncQuestionsField) => void
  /** A drain consumed every line before `mark.offset`: share the fold, retry a failed read. */
  afterDrain: (mark: TranscriptAsyncQuestionFoldMark | null) => void
  /** Whether a failed reconstruction is due a retry (the watcher then drains). */
  wantsRetry: () => boolean
  dispose: () => void
}

const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 30_000

export function createTranscriptAsyncQuestionTracker(args: {
  filePath: string
  /** Called when a reconstruction settles outside a drain. */
  onSettled: () => void
  scan?: typeof scanCodexAsyncQuestionFactsBefore
  fingerprint?: typeof boundaryFingerprint
}): TranscriptAsyncQuestionTracker {
  const { filePath } = args
  const scan = args.scan ?? scanCodexAsyncQuestionFactsBefore
  const fingerprint = args.fingerprint ?? boundaryFingerprint
  let fold: NativeChatAsyncQuestionFoldState = createNativeChatAsyncQuestionFoldState()
  // Not complete: facts observed past the boundary wait in `buffered`.
  let complete = true
  let running = false
  let failed: { endOffset: number; version: TranscriptFileVersion } | null = null
  let buffered: NativeChatAsyncQuestionFact[] = []
  let generation = 0
  let disposed = false
  let controller = new AbortController()
  let published: NativeChatAsyncQuestionsField | undefined
  let consecutiveFailures = 0
  let retryNotBefore = 0
  // The last drain's mark while no line has been observed since (the fold ends exactly there).
  let drainMark: TranscriptAsyncQuestionFoldMark | null = null

  function currentField(): NativeChatAsyncQuestionsField {
    if (failed) {
      return { state: 'absent' }
    }
    return complete
      ? publishNativeChatAsyncQuestions(nativeChatAsyncQuestionsFromFold(fold))
      : { state: 'pending' }
  }

  function remember(): void {
    if (complete && drainMark) {
      rememberTranscriptAsyncQuestionFold(filePath, drainMark, fold)
    }
  }

  function reset(): void {
    generation += 1
    controller.abort()
    controller = new AbortController()
    fold = createNativeChatAsyncQuestionFoldState()
    buffered = []
    failed = null
    consecutiveFailures = 0
    drainMark = null
    running = false
  }

  /** The cached fold, if the bytes it covers are still the file's. */
  async function verifiedBase(
    cached: RecalledTranscriptAsyncQuestionFold | null,
    signal: AbortSignal
  ): Promise<RecalledTranscriptAsyncQuestionFold | null> {
    return cached && (await fingerprint(filePath, cached.offset, signal)) === cached.boundary
      ? cached
      : null
  }

  async function reconstruct(
    endOffset: number,
    cached: RecalledTranscriptAsyncQuestionFold | null,
    signal: AbortSignal
  ): Promise<NativeChatAsyncQuestionFoldState> {
    const base = await verifiedBase(cached, signal)
    const scanned = await scan(filePath, endOffset, signal, base?.offset ?? 0)
    const next =
      base && !scanned.reachedBoundary ? base.fold : createNativeChatAsyncQuestionFoldState()
    for (const fact of scanned.facts) {
      foldNativeChatAsyncQuestionFact(next, fact)
    }
    return next
  }

  function start(endOffset: number, version: TranscriptFileVersion): void {
    const cached = recallTranscriptAsyncQuestionFold(filePath, version, endOffset)
    if (cached?.exact) {
      fold = cached.fold
      for (const fact of buffered) {
        foldNativeChatAsyncQuestionFact(fold, fact)
      }
      buffered = []
      complete = true
      failed = null
      return
    }
    complete = false
    running = true
    const runGeneration = generation
    void reconstruct(endOffset, cached, controller.signal).then(
      (next) => {
        if (disposed || runGeneration !== generation) {
          return
        }
        fold = next
        for (const fact of buffered) {
          foldNativeChatAsyncQuestionFact(fold, fact)
        }
        buffered = []
        complete = true
        running = false
        failed = null
        consecutiveFailures = 0
        remember()
        args.onSettled()
      },
      (error: unknown) => {
        if (disposed || runGeneration !== generation) {
          return
        }
        // Never partial: `absent` until a retry succeeds; buffered lines still apply after it.
        running = false
        failed = { endOffset, version }
        consecutiveFailures += 1
        retryNotBefore =
          Date.now() + Math.min(RETRY_BASE_MS * 2 ** (consecutiveFailures - 1), RETRY_MAX_MS)
        console.warn('[native-chat] async-question reconstruction failed', error)
        args.onSettled()
      }
    )
  }

  function wantsRetry(): boolean {
    return failed !== null && !running && !disposed && Date.now() >= retryNotBefore
  }

  function observe(facts: readonly NativeChatAsyncQuestionFact[]): void {
    drainMark = null
    for (const fact of facts) {
      if (complete) {
        foldNativeChatAsyncQuestionFact(fold, fact)
      } else {
        buffered.push(fact)
      }
    }
  }

  return {
    begin: (endOffset, version) => {
      reset()
      start(endOffset, version)
    },
    beginFromStart: () => {
      reset()
      complete = true
    },
    observeLine: (line, recordId) => observe(codexRolloutAsyncQuestionFacts(line, recordId)),
    observeOversizedRecord: (head) =>
      observe(codexOversizedRolloutRecordFacts(head.toString('utf8'))),
    field: currentField,
    takeChanged: () => {
      const next = currentField()
      if (nativeChatAsyncQuestionsFieldsEqual(next, published)) {
        return undefined
      }
      published = next
      return next
    },
    markPublished: (field) => {
      published = field
    },
    afterDrain: (mark) => {
      drainMark = mark
      remember()
      if (failed && wantsRetry()) {
        start(failed.endOffset, failed.version)
        if (complete) {
          // Answered from the shared fold: this drain already published, so settle now.
          args.onSettled()
        }
      }
    },
    wantsRetry,
    dispose: () => {
      disposed = true
      controller.abort()
    }
  }
}

/** The fold mark of a drain that ended on a line boundary, else null (a line is mid-read). */
export function transcriptAsyncQuestionDrainMark(
  state: IncrementalTranscriptState,
  boundary: string,
  version: TranscriptFileVersion
): TranscriptAsyncQuestionFoldMark | null {
  return state.pendingStart === state.offset && !state.droppingOversizedRecord
    ? { version, offset: state.offset, boundary }
    : null
}

export type WatchedTranscriptAsyncQuestions = Pick<
  TranscriptAsyncQuestionTracker,
  'begin' | 'beginFromStart' | 'wantsRetry' | 'takeChanged' | 'dispose'
> & {
  /** After a successful drain: the watcher's read state, its boundary and the file version. */
  afterDrain: (
    state: IncrementalTranscriptState,
    boundary: string,
    version: TranscriptFileVersion
  ) => void
  /** Decoder for reads past the boundary: feeds each line to the fold, then decodes it. */
  readDecode: NativeChatLineDecoder
  observeOversizedRecord: OversizedTranscriptRecordObserver
  /** The field a snapshot or replacement carries, recorded as published. */
  snapshotField: () => NativeChatAsyncQuestionsField
}

/** The watcher's async-question wiring; null (no field, no cost) for non-Codex agents. */
export function createWatchedTranscriptAsyncQuestions(
  args: Pick<SubscribeNativeChatTranscriptArgs, 'agent' | 'onAppend'>,
  filePath: string,
  decode: NativeChatLineDecoder,
  canPublish: () => boolean
): WatchedTranscriptAsyncQuestions | null {
  if (resolveNativeChatTranscriptAgent(args.agent) !== 'codex') {
    return null
  }
  const tracker = createTranscriptAsyncQuestionTracker({
    filePath,
    onSettled: () => {
      const changed = canPublish() ? tracker.takeChanged() : undefined
      if (changed) {
        args.onAppend([], undefined, changed)
      }
    }
  })
  return {
    begin: tracker.begin,
    beginFromStart: tracker.beginFromStart,
    wantsRetry: tracker.wantsRetry,
    afterDrain: (state, boundary, version) =>
      tracker.afterDrain(transcriptAsyncQuestionDrainMark(state, boundary, version)),
    takeChanged: tracker.takeChanged,
    dispose: tracker.dispose,
    observeOversizedRecord: tracker.observeOversizedRecord,
    readDecode: (line, fallbackId) => {
      tracker.observeLine(line, fallbackId)
      return decode(line, fallbackId)
    },
    snapshotField: () => {
      const field = tracker.field()
      tracker.markPublished(field)
      return field
    }
  }
}
