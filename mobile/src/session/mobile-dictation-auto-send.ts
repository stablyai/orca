import { createContext, useEffect, useState, useSyncExternalStore } from 'react'
import { AccessibilityInfo, Platform } from 'react-native'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MOBILE_QUEUED_EDIT_SCOPE_PREFIX } from './mobile-queued-message-edit-open'
import { readFocusedMobileNativeChatTextScope } from './native-chat/composer/mobile-native-chat-draft-inputs'

const DEFAULT_AUTO_SEND_DELAY_MS = 2000
const MAX_AUTO_SEND_DELAY_MS = 10_000

// Send saves a queued-message edit, so dictation into one must never auto-send.
export function dictationTargetsQueuedEdit(): boolean {
  return (
    readFocusedMobileNativeChatTextScope()?.startsWith(MOBILE_QUEUED_EDIT_SCOPE_PREFIX) === true
  )
}

export function resolveMobileDictationAutoSendDelayMs(delayMs: number | undefined): number {
  return typeof delayMs === 'number' && delayMs > 0 && delayMs <= MAX_AUTO_SEND_DELAY_MS
    ? delayMs
    : DEFAULT_AUTO_SEND_DELAY_MS
}

type MobileDictationAutoSendSnapshot = { deadline: number; delayMs: number }

// The session arms one pending send per dictation; the composer shows it and supplies the sender.
export type MobileDictationAutoSend = {
  arm: () => void
  // Also disarms, so a transcript still in flight after the user takes over stays a draft.
  withdraw: () => void
  startIfArmed: (delayMs: number) => void
  setSender: (send: (() => void) | null) => void
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => MobileDictationAutoSendSnapshot | null
}

// The session's pending send, for the chat composer to show, cancel and fire.
export const MobileDictationAutoSendContext = createContext<MobileDictationAutoSend | null>(null)

export function createMobileDictationAutoSend(): MobileDictationAutoSend {
  let snapshot: MobileDictationAutoSendSnapshot | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let sender: (() => void) | null = null
  let armed = false
  const listeners = new Set<() => void>()

  const publish = (next: MobileDictationAutoSendSnapshot | null): void => {
    snapshot = next
    for (const listener of listeners) {
      listener()
    }
  }
  const cancel = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (snapshot) {
      publish(null)
    }
  }

  const start = (delayMs: number): void => {
    cancel()
    timer = setTimeout(() => {
      timer = null
      publish(null)
      sender?.()
    }, delayMs)
    publish({ deadline: Date.now() + delayMs, delayMs })
  }

  return {
    arm: () => {
      armed = true
    },
    withdraw: () => {
      armed = false
      cancel()
    },
    startIfArmed: (delayMs) => {
      if (armed) {
        armed = false
        start(delayMs)
      }
    },
    setSender: (send) => {
      sender = send
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => snapshot
  }
}

function mobileDictationAutoSendAnnouncement(t: Translate, delayMs: number): string {
  const count = Math.ceil(delayMs / 1000)
  return count === 1
    ? t(
        'chat.dictationAutoSend.announcement_one',
        'Sending message in {{count}} second. Tap Cancel to keep it as a draft.',
        { count }
      )
    : t(
        'chat.dictationAutoSend.announcement_other',
        'Sending message in {{count}} seconds. Tap Cancel to keep it as a draft.',
        { count }
      )
}

const NO_SNAPSHOT = (): null => null
const NO_SUBSCRIPTION = (): (() => void) => () => {}

export function useMobileDictationAutoSendCountdown(
  autoSend: MobileDictationAutoSend | null,
  sendSurfaceId: string,
  send: () => void
): { secondsLeft: number | null; announcement: string | null } {
  const snapshot = useSyncExternalStore(
    autoSend?.subscribe ?? NO_SUBSCRIPTION,
    autoSend?.getSnapshot ?? NO_SNAPSHOT
  )
  const [now, setNow] = useState(() => Date.now())
  const t = useMobileTranslation()

  useEffect(() => {
    autoSend?.setSender(send)
    return () => autoSend?.setSender(null)
  }, [autoSend, send])

  // A send must never land on a different chat than the one the words were dictated into.
  useEffect(() => () => autoSend?.withdraw(), [autoSend, sendSurfaceId])

  useEffect(() => {
    if (!snapshot) {
      return
    }
    // iOS ignores live regions; the served page and Android read the composer's live region.
    if (Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibilityWithOptions(
        mobileDictationAutoSendAnnouncement(t, snapshot.delayMs),
        { queue: false }
      )
    }
    const interval = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(interval)
  }, [snapshot, t])

  if (!snapshot) {
    return { secondsLeft: null, announcement: null }
  }
  // `now` can predate this countdown until the first tick, so cap at the full delay.
  const remainingMs = Math.min(snapshot.delayMs, snapshot.deadline - now)
  return {
    secondsLeft: Math.max(0, Math.ceil(remainingMs / 1000)),
    announcement: mobileDictationAutoSendAnnouncement(t, snapshot.delayMs)
  }
}
