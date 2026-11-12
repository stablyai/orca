import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMobileDictation } from '../hooks/use-mobile-dictation'
import type { UseMobileDictationResult } from '../hooks/mobile-dictation-session-state'
import { useRouteHandoff } from '../navigation/route-handoff'
import { triggerError } from '../platform/haptics'
import { useClipboardWriter } from '../platform/clipboard'
import { dictationFailureMessage, isDictationSetupRequiredError } from './mobile-dictation-setup'
import { useMobileDictationHaptics } from './use-mobile-dictation-haptics'
import { useMobileDictationSilenceStop } from './use-mobile-dictation-silence-stop'
import { DEFAULT_STOP_AFTER_SILENCE_SECONDS } from '../../../src/shared/dictation-silence-stop'
import { insertMobileDictationAway } from './mobile-dictation-away-insert'
import { nativeChatDictationCopy } from './mobile-session-native-chat-dictation-copy'
import { dictationAwayCopy } from './mobile-dictation-away-copy'
import {
  useMobileDictationAnnouncements,
  useMobileDictationSpeech
} from './use-mobile-dictation-announcements'
import {
  MobileDictationClearanceContext,
  MobileDictationHostContext,
  MobileDictationPillContext,
  type MobileDictationHost,
  type MobileDictationHostToast,
  type MobileDictationOwner,
  type MobileDictationScreen
} from './mobile-dictation-host-context'

export { useMobileDictationHost } from './mobile-dictation-host-context'

// The owner's screen; startingOnly asks only for the screen that started it.
function screenFor(
  screens: ReadonlySet<MobileDictationScreen>,
  owner: MobileDictationOwner | null,
  startingOnly: boolean
): MobileDictationScreen | null {
  const matches = [...screens].filter((screen) => owner && screen.sessionKey === owner.sessionKey)
  const starting = matches.find((screen) => screen.instance === owner?.instance) ?? null
  if (startingOnly) {
    return starting
  }
  // Else the one in front, then the one that started it, then the newest copy of its session.
  return matches.find((screen) => screen.shown()) ?? starting ?? matches.at(-1) ?? null
}

function isUnderway(dictation: UseMobileDictationResult): boolean {
  return (
    dictation.isStarting ||
    dictation.isRecording ||
    dictation.isProcessing ||
    dictation.failure !== null
  )
}

// One dictation per host document, above its screens, so it keeps going when its session leaves the screen.
export function MobileDictationHostProvider({ children }: { children: ReactNode }) {
  const router = useRouteHandoff()
  const [owner, setOwner] = useState<MobileDictationOwner | null>(null)
  const ownerRef = useRef(owner)
  const screensRef = useRef(new Set<MobileDictationScreen>())
  const [, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision((revision) => revision + 1), [])
  const [toast, setToast] = useState<MobileDictationHostToast | null>(null)
  const clearToast = useCallback(() => setToast(null), [])
  const [clearances, setClearances] = useState<ReadonlyMap<symbol, number>>(new Map())
  const clipboard = useClipboardWriter()
  const speech = useMobileDictationSpeech()
  const { say: speak } = speech

  // Bring a dictation's target back: its screen if one is still mounted, otherwise open the session again.
  const openOwner = useCallback(
    (target: MobileDictationOwner) => {
      const screen = screenFor(screensRef.current, target, false)
      if (screen) {
        screen.bringToFront(target.paneKey)
      } else {
        router.push(target.href)
      }
    },
    [router]
  )
  const open = useCallback(() => {
    if (ownerRef.current) {
      openOwner(ownerRef.current)
    }
  }, [openOwner])

  // Say it on the screen that shows the dictation, else in the host's toast (with Open for the dictation it is about).
  // A screen's toast is not read by VoiceOver on the page, so it is spoken too; the host's toast is spoken when it shows.
  const say = (message: string, about?: MobileDictationOwner) => {
    const screen = screenFor(screensRef.current, ownerRef.current, false)
    if (screen?.shown()) {
      screen.toast(message)
      speak(message)
    } else {
      setToast(about ? { message, open: () => openOwner(about) } : { message })
    }
  }
  const reportFailureRef = useRef((err: Error) => {
    const screen = screenFor(screensRef.current, ownerRef.current, false)
    if (screen?.shown()) {
      screen.reportFailure(err)
      // A setup refusal opens the setup sheet, which is read on its own.
      if (!isDictationSetupRequiredError(err.message)) {
        speak(dictationFailureMessage(err.message))
      }
      return
    }
    triggerError()
    setToast({ message: dictationFailureMessage(err.message) })
  })

  const dictation = useMobileDictation({
    client: owner?.client ?? null,
    enabled: true,
    removeFillerWords: owner?.removeFillerWords ?? true,
    dictationTerms: owner?.dictationTerms,
    worktreeId: owner?.worktreeId,
    onTranscript: (text) => {
      const current = ownerRef.current
      if (!current) {
        return
      }
      const starting = screenFor(screensRef.current, current, true)
      if (starting?.shown() && starting.insert(text)) {
        return
      }
      void insertMobileDictationAway(current, text).then((inserted) => {
        if (inserted) {
          say(dictationAwayCopy.insertedIn(current), current)
          return
        }
        triggerError()
        void clipboard.writeText(text).then(
          () => say(nativeChatDictationCopy.insertFailedCopied()),
          () => say(nativeChatDictationCopy.insertFailed())
        )
      })
    },
    onError: (err, { kept }) => {
      if (kept) {
        triggerError()
      } else {
        reportFailureRef.current(err)
      }
    },
    onAudioLimitReached: () => say(nativeChatDictationCopy.stoppedAtCloudLimit())
  })
  const stop = useMobileDictationHaptics(dictation)
  useMobileDictationSilenceStop(
    dictation,
    owner?.dictationMode,
    // Off is null, so only a missing owner takes the default.
    owner ? owner.silenceSeconds : DEFAULT_STOP_AFTER_SILENCE_SECONDS,
    stop,
    (message) => say(message)
  )

  // Screens subscribe to the live dictation; the host's context only changes when its owner or pill does.
  const liveRef = useRef<UseMobileDictationResult>(dictation)
  const listenersRef = useRef(new Set<() => void>())
  const {
    meter,
    start: startDictation,
    stop: stopDictation,
    cancel: cancelDictation,
    retry
  } = dictation
  const away =
    owner !== null &&
    isUnderway(dictation) &&
    screenFor(screensRef.current, owner, false)?.shown() !== true
  const { noteCancel } = useMobileDictationAnnouncements(
    dictation,
    { computerName: owner?.computerName ?? null, away, toast: toast?.message ?? null },
    speak
  )
  // Every ✕ (in place, the pill, the terminal's long press) ends here, so a cancel is never read as "Inserted."
  const cancel = useCallback(() => {
    noteCancel()
    return cancelDictation()
  }, [cancelDictation, noteCancel])
  const published = useMemo(() => ({ ...dictation, cancel }), [cancel, dictation])
  const idle = useMemo<UseMobileDictationResult>(
    () => ({
      status: 'idle',
      isStarting: false,
      isRecording: false,
      isProcessing: false,
      transcriptSoFar: '',
      error: null,
      failure: null,
      engine: null,
      meter,
      start: startDictation,
      stop: stopDictation,
      cancel,
      retry
    }),
    [cancel, meter, retry, startDictation, stopDictation]
  )
  const idleRef = useRef(idle)
  useLayoutEffect(() => {
    liveRef.current = published
    idleRef.current = idle
    for (const listener of listenersRef.current) {
      listener()
    }
  })
  const subscribe = useCallback((listener: () => void) => {
    listenersRef.current.add(listener)
    return () => {
      listenersRef.current.delete(listener)
    }
  }, [])
  const getDictation = useCallback(() => liveRef.current, [])
  const getIdleDictation = useCallback(() => idleRef.current, [])
  const getUnderway = useCallback(() => isUnderway(liveRef.current), [])

  const start = useCallback(
    async (next: MobileDictationOwner) => {
      ownerRef.current = next
      setOwner(next)
      try {
        await startDictation(next.client)
      } catch (err) {
        // The starting screen may already be gone, so a refused start is told wherever the user is now.
        reportFailureRef.current(err instanceof Error ? err : new Error(String(err)))
      }
    },
    [startDictation]
  )

  const attach = useCallback(
    (screen: MobileDictationScreen) => {
      screensRef.current.add(screen)
      refresh()
      return () => {
        screensRef.current.delete(screen)
        refresh()
      }
    },
    [refresh]
  )
  const setClearance = useCallback((id: symbol, height: number) => {
    setClearances((current) => {
      if ((current.get(id) ?? 0) === height) {
        return current
      }
      const next = new Map(current)
      if (height > 0) {
        next.set(id, height)
      } else {
        next.delete(id)
      }
      return next
    })
  }, [])

  const title = owner?.title ?? ''
  const clearance = Math.max(0, ...clearances.values())
  const pill = useMemo(
    () => ({ away, title, open, toast, clearToast, clearance, liveText: speech.liveText }),
    [speech.liveText, away, clearToast, clearance, open, title, toast]
  )
  const value = useMemo<MobileDictationHost>(
    () => ({
      owner,
      start,
      stop,
      announce: speak,
      attach,
      refresh,
      subscribe,
      getDictation,
      getIdleDictation,
      getUnderway
    }),
    [
      attach,
      getDictation,
      getIdleDictation,
      getUnderway,
      owner,
      refresh,
      speak,
      start,
      stop,
      subscribe
    ]
  )
  return (
    <MobileDictationClearanceContext.Provider value={setClearance}>
      <MobileDictationHostContext.Provider value={value}>
        <MobileDictationPillContext.Provider value={pill}>
          {children}
        </MobileDictationPillContext.Provider>
      </MobileDictationHostContext.Provider>
    </MobileDictationClearanceContext.Provider>
  )
}
