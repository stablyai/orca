import { useEffect, useSyncExternalStore } from 'react'
import { AppState, type NativeEventSubscription } from 'react-native'
import type { ReadAloudEngine } from './read-aloud-contract'

// One reply speaks at a time across the chat; rows come and go as the list scrolls, so the turn lives here.
type Turn = { id: string; engine: ReadAloudEngine }

let current: Turn | null = null
let leaving: NativeEventSubscription | null = null
const listeners = new Set<() => void>()

function setTurn(turn: Turn | null): void {
  current = turn
  // Watched only while a voice plays: leaving the app stops it.
  if (turn && !leaving) {
    leaving = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        stopReadAloud()
      }
    })
  } else if (!turn && leaving) {
    leaving.remove()
    leaving = null
  }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function stopReadAloud(): void {
  const turn = current
  if (turn) {
    setTurn(null)
    turn.engine.stop()
  }
}

export function toggleReadAloud(engine: ReadAloudEngine, id: string, text: string): void {
  if (current?.id === id) {
    stopReadAloud()
    return
  }
  stopReadAloud()
  const turn = { id, engine }
  setTurn(turn)
  void engine.speak(text).finally(() => {
    if (current === turn) {
      setTurn(null)
    }
  })
}

export function useReadAloudSpeaking(id: string): boolean {
  return useSyncExternalStore(subscribe, () => current?.id === id)
}

/** Stops the voice when the chat changes or closes. */
export function useStopReadAloudWithChat(scopeKey: string): void {
  useEffect(() => stopReadAloud, [scopeKey])
}
