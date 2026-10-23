import { useEffect, useState, useSyncExternalStore } from 'react'
import { AccessibilityInfo, Platform } from 'react-native'

const DEFAULT_AUTO_SEND_DELAY_MS = 2000
const MAX_AUTO_SEND_DELAY_MS = 10_000

/** The host's delay when it is a sane one, the desktop default otherwise. */
export function resolveMobileDictationAutoSendDelayMs(delayMs: number | undefined): number {
  return typeof delayMs === 'number' && delayMs > 0 && delayMs <= MAX_AUTO_SEND_DELAY_MS
    ? delayMs
    : DEFAULT_AUTO_SEND_DELAY_MS
}

export type MobileDictationAutoSendSnapshot = { deadline: number; delayMs: number }

/**
 * The one pending "send when dictation ends" for a session screen. The session arms it when
 * dictation starts, starts the countdown when that dictation's chat transcript lands, and withdraws
 * it when the screen, the app or the chat goes away; the composer shows it, cancels it from the
 * user's own gestures, and supplies the send it fires.
 */
export type MobileDictationAutoSend = {
  /** Lets the next transcript start a countdown. */
  arm: () => void
  /** Cancels any countdown and disarms, so a transcript still in flight stays a draft. */
  withdraw: () => void
  /** Starts the countdown only if armed, and disarms: one dictation, at most one send. */
  startIfArmed: (delayMs: number) => void
  start: (delayMs: number) => void
  cancel: () => void
  setSender: (send: (() => void) | null) => void
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => MobileDictationAutoSendSnapshot | null
}

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
      // Why: no mounted composer means no chat to send from, so nothing is sent.
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
    start,
    cancel,
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

/** What a screen reader hears once when a countdown starts; the ticking seconds stay silent. */
export function mobileDictationAutoSendAnnouncement(delayMs: number): string {
  const seconds = Math.ceil(delayMs / 1000)
  return `Sending message in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}. Tap Cancel to keep it as a draft.`
}

const NO_SNAPSHOT = (): null => null
const NO_SUBSCRIPTION = (): (() => void) => () => {}

/**
 * The composer's view of the pending send: seconds left and the one-time announcement while it
 * counts down, nulls otherwise. Registers `send` as what the countdown fires, and withdraws it when
 * the chat surface changes or the composer goes away.
 */
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

  useEffect(() => {
    autoSend?.setSender(send)
    return () => autoSend?.setSender(null)
  }, [autoSend, send])

  // Why: a send must never land on a different chat than the one the words were dictated into.
  useEffect(() => () => autoSend?.withdraw(), [autoSend, sendSurfaceId])

  useEffect(() => {
    if (!snapshot) {
      return
    }
    // Why: iOS ignores live regions; the served page and Android read the composer's live region.
    if (Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibilityWithOptions(
        mobileDictationAutoSendAnnouncement(snapshot.delayMs),
        { queue: false }
      )
    }
    const interval = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(interval)
  }, [snapshot])

  if (!snapshot) {
    return { secondsLeft: null, announcement: null }
  }
  // Why: `now` can predate this countdown until the first tick, so cap at the full delay.
  const remainingMs = Math.min(snapshot.delayMs, snapshot.deadline - now)
  return {
    secondsLeft: Math.max(0, Math.ceil(remainingMs / 1000)),
    announcement: mobileDictationAutoSendAnnouncement(snapshot.delayMs)
  }
}
