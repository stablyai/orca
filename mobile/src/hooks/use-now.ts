import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AppState, type AppStateStatus } from 'react-native'

const appStateListeners = new Set<() => void>()
// Read on first subscribe, so importing this module never touches AppState.
let currentAppState: AppStateStatus | null = null
let appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null

function subscribeToAppState(listener: () => void): () => void {
  appStateListeners.add(listener)
  if (!appStateSubscription) {
    currentAppState = AppState.currentState
    appStateSubscription = AppState.addEventListener('change', (nextState) => {
      currentAppState = nextState
      appStateListeners.forEach((notify) => notify())
    })
  }

  return () => {
    appStateListeners.delete(listener)
    if (appStateListeners.size === 0) {
      appStateSubscription?.remove()
      appStateSubscription = null
    }
  }
}

function isAppActive(): boolean {
  return (appStateSubscription ? currentAppState : AppState.currentState) === 'active'
}

/** True while the app (or the page's document) is in the foreground. */
export function useAppActive(): boolean {
  return useSyncExternalStore(subscribeToAppState, isAppActive, isAppActive)
}

// A list-level caller's single tick drives every visible relative-time label.
export function useNow(intervalMs = 30_000, enabled = true): number {
  const appActive = useAppActive()
  const running = appActive && enabled
  const [now, setNow] = useState(() => Date.now())
  const wasRunningRef = useRef(running)

  useEffect(() => {
    const resumed = running && !wasRunningRef.current
    wasRunningRef.current = running
    if (!running) {
      return
    }
    if (resumed) {
      setNow(Date.now())
    }
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs, running])

  return now
}

type SharedClock = {
  now: number
  listeners: Set<() => void>
  timer: ReturnType<typeof setInterval> | null
  stopWatchingApp: (() => void) | null
}

const sharedClocks = new Map<number, SharedClock>()

function sharedClock(intervalMs: number): SharedClock {
  let clock = sharedClocks.get(intervalMs)
  if (!clock) {
    clock = { now: Date.now(), listeners: new Set(), timer: null, stopWatchingApp: null }
    sharedClocks.set(intervalMs, clock)
  } else if (clock.listeners.size === 0 && Date.now() - clock.now >= intervalMs) {
    // A stopped clock catches up before render, once, so every reader in that render sees one time.
    clock.now = Date.now()
  }
  return clock
}

function tick(clock: SharedClock): void {
  clock.now = Date.now()
  clock.listeners.forEach((notify) => notify())
}

function stopTimer(clock: SharedClock): void {
  if (clock.timer !== null) {
    clearInterval(clock.timer)
    clock.timer = null
  }
}

/**
 * The same clock as useNow, shared by every caller of one interval, so a list ticks only the rows that read it
 * (one timer, one timestamp). It runs only in the foreground and catches up on return.
 */
export function useSharedNow(intervalMs = 30_000): number {
  return useSharedNowSnapshot(intervalMs, readNow)
}

const readNow = (now: number): number => now

export function useSharedNowSnapshot<T>(intervalMs: number, select: (now: number) => T): T {
  const clock = sharedClock(intervalMs)
  const subscribe = useCallback(
    (listener: () => void) => {
      const startTimer = (): void => {
        clock.timer ??= setInterval(() => tick(clock), intervalMs)
      }
      if (clock.listeners.size === 0) {
        if (isAppActive()) {
          // A clock stopped less than one interval ago still holds its old time; refresh it on remount.
          tick(clock)
          startTimer()
        }
        clock.stopWatchingApp = subscribeToAppState(() => {
          if (isAppActive()) {
            tick(clock)
            startTimer()
          } else {
            stopTimer(clock)
          }
        })
      }
      clock.listeners.add(listener)
      return () => {
        clock.listeners.delete(listener)
        if (clock.listeners.size === 0) {
          stopTimer(clock)
          clock.stopWatchingApp?.()
          clock.stopWatchingApp = null
        }
      }
    },
    [clock, intervalMs]
  )
  const read = useCallback(() => select(clock.now), [clock, select])
  return useSyncExternalStore(subscribe, read, read)
}
