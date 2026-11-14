import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { UseMobileDictationResult } from '../hooks/mobile-dictation-session-state'
import { useAccessibilityAnnouncer } from '../platform/accessibility/accessibility-announcer'
import { dictationAnnounceCopy } from './mobile-dictation-announce-copy'
import { dictationKeptFailureCause } from './mobile-dictation-controls-copy'

// Finishing is said only when it is slow.
const FINISHING_ANNOUNCE_DELAY_MS = 1000

// What the shell could not speak, for the page's live region; the id changes on every message so a repeat is read again.
export type MobileDictationLiveText = { readonly text: string; readonly id: number }

// Speak to the screen reader through the shell where it can, else into the live region. say keeps its identity.
export function useMobileDictationSpeech(): {
  say: (message: string) => void
  liveText: MobileDictationLiveText
} {
  const announce = useAccessibilityAnnouncer()
  const announceRef = useRef(announce)
  useLayoutEffect(() => {
    announceRef.current = announce
  })
  const [liveText, setLiveText] = useState<MobileDictationLiveText>({ text: '', id: 0 })
  const say = useCallback((message: string) => {
    void announceRef.current(message).then((spoken) => {
      if (!spoken) {
        setLiveText((current) => ({ text: message, id: current.id + 1 }))
      }
    })
  }, [])
  return { say, liveText }
}

// The dictation's own spoken moments: start, leaving its screen, a move to the computer, a slow finish, a cancel, a kept failure, the host's toasts.
// Outcomes (inserted, failed) are said by whoever knows them: the screen that inserted, or the host's failure report.
export function useMobileDictationAnnouncements(
  dictation: Pick<UseMobileDictationResult, 'status' | 'engine' | 'failure'>,
  {
    computerName,
    away,
    toast
  }: { computerName: string | null; away: boolean; toast: string | null },
  say: (message: string) => void
): { noteCancel: () => void } {
  const { status, engine, failure } = dictation
  const previousStatus = useRef(status)
  const cancelled = useRef(false)
  const listeningSaid = useRef(false)
  const movedAtSaid = useRef<number | null>(null)
  const statusRef = useRef(status)

  useEffect(() => {
    const previous = previousStatus.current
    previousStatus.current = status
    statusRef.current = status
    if (status === 'starting') {
      cancelled.current = false
      listeningSaid.current = false
    }
    // Only a ✕ (including Discard on a kept failure); a refused start's reason is said where it is reported.
    if (status === 'idle' && previous !== 'idle' && cancelled.current) {
      say(dictationAnnounceCopy.cancelled())
    }
    if (status === 'idle') {
      cancelled.current = false
    }
  }, [say, status])

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

  useEffect(() => {
    if (failure) {
      say(dictationAnnounceCopy.stoppedKept(dictationKeptFailureCause(failure)))
    }
  }, [failure, say])

  const noteCancel = useCallback(() => {
    cancelled.current = true
  }, [])
  return { noteCancel }
}
