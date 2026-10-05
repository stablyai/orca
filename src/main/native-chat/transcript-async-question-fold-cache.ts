// Host-wide memo of each watched Codex rollout's async-question fold, so a re-subscribe
// reads only the bytes written since. A derivation cache, never a source of truth: a miss,
// an eviction or a changed file only means a rescan.

import {
  cloneNativeChatAsyncQuestionFoldState,
  type NativeChatAsyncQuestionFoldState
} from '../../shared/native-chat-async-questions'
import { transcriptFileVersionChanged, type TranscriptFileVersion } from './transcript-file-version'

export type TranscriptAsyncQuestionFoldMark = {
  /** The file as stat'd once the fold reached `offset`. */
  version: TranscriptFileVersion
  /** A line start: the fold covers every byte before it. */
  offset: number
  /** `boundaryFingerprint` at `offset`, to detect a rewrite under the same identity. */
  boundary: string
}

type CachedFold = TranscriptAsyncQuestionFoldMark & { fold: NativeChatAsyncQuestionFoldState }

const MAX_CACHED_FILES = 32
const cachedFolds = new Map<string, CachedFold>()

export function rememberTranscriptAsyncQuestionFold(
  filePath: string,
  mark: TranscriptAsyncQuestionFoldMark,
  fold: NativeChatAsyncQuestionFoldState
): void {
  cachedFolds.delete(filePath)
  cachedFolds.set(filePath, { ...mark, fold: cloneNativeChatAsyncQuestionFoldState(fold) })
  for (const oldest of cachedFolds.keys()) {
    if (cachedFolds.size <= MAX_CACHED_FILES) {
      break
    }
    cachedFolds.delete(oldest)
  }
}

export type RecalledTranscriptAsyncQuestionFold = CachedFold & {
  /** The file is unchanged since the fold was taken and it ends at the requested offset. */
  exact: boolean
}

/** A copy of the cached fold of this file if it can be extended to `endOffset`. */
export function recallTranscriptAsyncQuestionFold(
  filePath: string,
  version: TranscriptFileVersion,
  endOffset: number
): RecalledTranscriptAsyncQuestionFold | null {
  const cached = cachedFolds.get(filePath)
  if (!cached || cached.version.identity !== version.identity || cached.offset > endOffset) {
    return null
  }
  return {
    ...cached,
    fold: cloneNativeChatAsyncQuestionFoldState(cached.fold),
    exact: cached.offset === endOffset && !transcriptFileVersionChanged(version, cached.version)
  }
}
