import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { useMobileDictation } from '../hooks/use-mobile-dictation'
import type { UseMobileDictationResult } from '../hooks/mobile-dictation-session-state'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { useRouteHandoff } from '../navigation/route-handoff'
import { triggerError } from '../platform/haptics'
import { useClipboardWriter } from '../platform/clipboard'
import { dictationFailureMessage } from './mobile-dictation-setup'
import { useMobileDictationHaptics } from './use-mobile-dictation-haptics'
import { useMobileDictationSilenceStop } from './use-mobile-dictation-silence-stop'
import {
  insertMobileDictationAway,
  type MobileDictationAwayTarget
} from './mobile-dictation-away-insert'
import { nativeChatDictationCopy } from './mobile-session-native-chat-dictation-copy'
import { dictationAwayCopy } from './mobile-dictation-away-copy'

export type MobileDictationHostToast = { message: string; open?: () => void }

// Who started the dictation and where its words go, fixed at the tap: leaving the screen never moves them.
export type MobileDictationOwner = {
  // The starting screen instance, and the session it shows (a reopened screen of that session takes over its controls).
  readonly instance: object
  readonly sessionKey: string
  readonly client: RpcClient | null
  readonly deviceToken: string | null
  readonly target: MobileDictationAwayTarget
  // The target tab's title, for the pill and its toasts.
  readonly title: string
  // The session route that opens the target tab again.
  readonly href: string
  readonly dictationMode: string | undefined
  readonly removeFillerWords: boolean
}

// A mounted session screen, as the dictation host sees it.
export type MobileDictationScreen = {
  readonly instance: object
  readonly sessionKey: string
  // The one "shown" rule (mobile-dictation-shown.ts): true while the in-place controls stand for the dictation.
  readonly shown: () => boolean
  // The starting screen inserts where it started (cursor, live input); false when it cannot, so the host inserts instead.
  readonly insert: (text: string) => boolean
  // Setup refusals open its setup sheet; other failures toast on it.
  readonly reportFailure: (err: Error) => void
  readonly toast: (message: string) => void
}

type MobileDictationHost = {
  readonly dictation: UseMobileDictationResult
  readonly owner: MobileDictationOwner | null
  readonly start: (owner: MobileDictationOwner) => Promise<void>
  // Stop with the selection tick, as every stop button does.
  readonly stop: () => void
  readonly attach: (screen: MobileDictationScreen) => () => void
  // A screen's shown() answer changed; the pill reads it on render.
  readonly refresh: () => void
  // The floating pill's state: the dictation when its screen is not shown, and the host's toast.
  readonly pill: {
    readonly away: boolean
    readonly title: string
    readonly open: () => void
    readonly toast: MobileDictationHostToast | null
    readonly clearToast: () => void
  }
}

const MobileDictationHostContext = createContext<MobileDictationHost | null>(null)

export function useMobileDictationHost(): MobileDictationHost {
  const host = useContext(MobileDictationHostContext)
  if (!host) {
    throw new Error('useMobileDictationHost needs a MobileDictationHostProvider')
  }
  return host
}

function screenFor(
  screens: ReadonlySet<MobileDictationScreen>,
  owner: MobileDictationOwner | null,
  startingOnly: boolean
): MobileDictationScreen | null {
  for (const screen of screens) {
    if (
      owner &&
      screen.sessionKey === owner.sessionKey &&
      (!startingOnly || screen.instance === owner.instance)
    ) {
      return screen
    }
  }
  return null
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
  const clipboard = useClipboardWriter()

  // Bring the target back: pop to its session when that screen is still in the stack, otherwise open it again.
  const open = useCallback(() => {
    const current = ownerRef.current
    if (!current) {
      return
    }
    if (screenFor(screensRef.current, current, false)) {
      router.dismissTo(current.href)
    } else {
      router.push(current.href)
    }
  }, [router])

  // Tell the user where words went: on the screen when it shows the dictation, else the host's toast with Open.
  const say = (message: string, withOpen: boolean) => {
    const screen = screenFor(screensRef.current, ownerRef.current, false)
    if (screen?.shown()) {
      screen.toast(message)
    } else {
      setToast(withOpen ? { message, open } : { message })
    }
  }

  const dictation = useMobileDictation({
    client: owner?.client ?? null,
    enabled: true,
    removeFillerWords: owner?.removeFillerWords ?? true,
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
          say(dictationAwayCopy.insertedIn(current), true)
          return
        }
        triggerError()
        void clipboard.writeText(text).then(
          () => say(nativeChatDictationCopy.insertFailedCopied(), false),
          () => say(nativeChatDictationCopy.insertFailed(), false)
        )
      })
    },
    onError: (err, { kept }) => {
      if (kept) {
        triggerError()
        return
      }
      const screen = screenFor(screensRef.current, ownerRef.current, false)
      if (screen?.shown()) {
        screen.reportFailure(err)
        return
      }
      triggerError()
      setToast({ message: dictationFailureMessage(err.message) })
    },
    onAudioLimitReached: () => say(nativeChatDictationCopy.stoppedAtCloudLimit(), false)
  })
  const stop = useMobileDictationHaptics(dictation)
  useMobileDictationSilenceStop(dictation, owner?.dictationMode, stop, (message) =>
    say(message, false)
  )

  const { start: startDictation } = dictation
  const start = useCallback(
    async (next: MobileDictationOwner) => {
      ownerRef.current = next
      setOwner(next)
      await startDictation(next.client)
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

  const underway =
    dictation.isStarting ||
    dictation.isRecording ||
    dictation.isProcessing ||
    dictation.failure !== null
  const away = owner !== null && underway && !screenFor(screensRef.current, owner, false)?.shown()
  const title = owner?.title ?? ''
  const pill = useMemo(
    () => ({ away, title, open, toast, clearToast }),
    [away, clearToast, open, title, toast]
  )
  const value = useMemo<MobileDictationHost>(
    () => ({ dictation, owner, start, stop, attach, refresh, pill }),
    [attach, dictation, owner, pill, refresh, start, stop]
  )
  return (
    <MobileDictationHostContext.Provider value={value}>
      {children}
    </MobileDictationHostContext.Provider>
  )
}
