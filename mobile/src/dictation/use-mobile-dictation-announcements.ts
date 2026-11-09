import { useCallback, useEffect, useRef, useState } from 'react'
import type { UseMobileDictationResult } from '../hooks/mobile-dictation-session-state'
import { useAccessibilityAnnouncer } from '../platform/accessibility-announcer'
import { dictationAnnounceCopy } from './mobile-dictation-announce-copy'
import { dictationFailureReason } from './mobile-dictation-controls-copy'
import { dictationFailureMessage } from './mobile-dictation-setup'

// Finishing is said only when it is slow; a fast finish goes straight to "Inserted."
const FINISHING_ANNOUNCE_DELAY_MS = 1000

// The dictation's spoken moments: start, leaving its screen, a move to the computer, a slow finish, the outcome, a failure, the host's toasts.
// The shell announces them where it can; otherwise they go to the returned live-region text.
export function useMobileDictationAnnouncements(
  dictation: Pick<UseMobileDictationResult, 'status' | 'engine' | 'failure' | 'error'>,
  {
    computerName,
    inPlace,
    away,
    toast
  }: {
    computerName: string | null
    // Its session screen is in front, so a landing is said here; away, the host's toast says where it went.
    inPlace: boolean
    away: boolean
    toast: string | null
  }
): { liveText: string; noteCancel: () => void } {
  const announce = useAccessibilityAnnouncer()
  const [liveText, setLiveText] = useState('')
  const say = useCallback(
    (message: string) => {
      void announce(message).then((spoken) => setLiveText(spoken ? '' : message))
    },
    [announce]
  )
  const { status, engine, failure, error } = dictation
  const previousStatus = useRef(status)
  const cancelled = useRef(false)
  const listeningSaid = useRef(false)
  const movedAtSaid = useRef<number | null>(null)
  const inPlaceRef = useRef(inPlace)
  const statusRef = useRef(status)

  useEffect(() => {
    const previous = previousStatus.current
    previousStatus.current = status
    if (status === 'starting') {
      cancelled.current = false
      listeningSaid.current = false
    }
    if (status === 'idle' && previous !== 'idle' && previous !== 'error') {
      // A stop goes through finishing; reaching idle any other way, or after ✕, is a cancel.
      if (cancelled.current || previous !== 'processing') {
        say(dictationAnnounceCopy.cancelled())
      } else if (inPlaceRef.current) {
        say(dictationAnnounceCopy.inserted())
      }
      cancelled.current = false
    }
  }, [say, status])

  useEffect(() => {
    inPlaceRef.current = inPlace
    statusRef.current = status
  })
  // Leaving the screen keeps it going; say so once, then the next screen reads as usual.
  useEffect(() => {
    if (away && statusRef.current === 'recording') {
      say(dictationAnnounceCopy.stillListening())
    }
  }, [away, say])
  useEffect(() => {
    if (toast) {
      say(toast)
    }
  }, [say, toast])

  useEffect(() => {
    if (status === 'recording' && engine && !listeningSaid.current) {
      listeningSaid.current = true
      say(dictationAnnounceCopy.listening(engine.kind, computerName))
    }
    if (engine?.movedAt != null && engine.movedAt !== movedAtSaid.current) {
      movedAtSaid.current = engine.movedAt
      say(dictationAnnounceCopy.movedToComputer(computerName))
    }
  }, [computerName, engine, say, status])

  useEffect(() => {
    if (status !== 'processing') {
      return
    }
    const timer = setTimeout(
      () => say(dictationAnnounceCopy.finishing()),
      FINISHING_ANNOUNCE_DELAY_MS
    )
    return () => clearTimeout(timer)
  }, [say, status])

  // A kept failure says what was kept; any other failure is a toast, which VoiceOver on the page never hears, so say it too.
  useEffect(() => {
    if (failure) {
      say(dictationAnnounceCopy.stoppedKept(dictationFailureReason(failure)))
    } else if (status === 'error' && error) {
      say(dictationFailureMessage(error))
    }
  }, [error, failure, say, status])

  const noteCancel = useCallback(() => {
    cancelled.current = true
  }, [])
  return { liveText, noteCancel }
}
