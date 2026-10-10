import { useCallback, useEffect, useRef } from 'react'
import type { MobileDictationCaptionReply } from '../dictation/dictation-reply-schema'
import type { DictationStatus } from './mobile-dictation-session-state'
import { MobileDictationCaptionStore } from './mobile-dictation-caption-store'

/**
 * Orders the live captions chunk replies carry. Chunk RPCs overlap (one every ~32 ms), so replies
 * can land out of order; the host's per-dictation revision only grows, so anything not newer than
 * what is shown is stale. A new dictation id starts a fresh revision sequence.
 */
export class MobileDictationLiveCaptionTracker {
  private dictationId: string | null = null
  private revision = Number.NEGATIVE_INFINITY
  private text = ''

  /** Returns the caption to show, or null when this reply changes nothing. */
  accept(dictationId: string, caption: MobileDictationCaptionReply): string | null {
    if (dictationId !== this.dictationId) {
      this.dictationId = dictationId
      this.revision = Number.NEGATIVE_INFINITY
      this.text = ''
    }
    if (caption.revision <= this.revision) {
      return null
    }
    this.revision = caption.revision
    const text = caption.text.trim()
    if (text === this.text) {
      return null
    }
    this.text = text
    return text
  }
}

/**
 * Live caption store for useMobileDictation. `isCurrent` must answer from refs written
 * synchronously (status + active id), so a reply that lands after stop/cancel is dropped.
 * Views paint the caption only while recording, so a cleared-late caption never shows.
 */
export function useMobileDictationLiveCaption(
  status: DictationStatus,
  isCurrent: (dictationId: string) => boolean
): {
  captionStore: MobileDictationCaptionStore
  acceptCaption: (dictationId: string, caption: MobileDictationCaptionReply) => void
} {
  const trackerRef = useRef(new MobileDictationLiveCaptionTracker())
  const storeRef = useRef(new MobileDictationCaptionStore())
  const isCurrentRef = useRef(isCurrent)
  isCurrentRef.current = isCurrent
  // Why: empty the external store before the next dictation can start painting into it.
  useEffect(() => {
    if (status !== 'recording') {
      storeRef.current.set('')
    }
  }, [status])

  const acceptCaption = useCallback((dictationId: string, next: MobileDictationCaptionReply) => {
    if (!isCurrentRef.current(dictationId)) {
      return
    }
    const text = trackerRef.current.accept(dictationId, next)
    if (text !== null) {
      storeRef.current.set(text)
    }
  }, [])

  return { captionStore: storeRef.current, acceptCaption }
}
