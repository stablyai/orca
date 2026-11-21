import { useEffect, useLayoutEffect, useRef } from 'react'
import { AppState } from 'react-native'

// `confirming` marks a round asked again right before a reload, rather than a return from the background.
type RoundListener = (round: number, confirming: boolean) => void

// Each listener's host: a return asks every host's pages, a confirm only the pages of the host about to reload.
const listeners = new Map<RoundListener, string>()
let round = 0
let unsubscribe: (() => void) | null = null

function announce(confirmingHost: string | null): number {
  round += 1
  listeners.forEach((hostId, listener) => {
    if (confirmingHost === null || hostId === confirmingHost) {
      listener(round, confirmingHost !== null)
    }
  })
  return round
}

// A return from the background (a screen back on, a switch back) starts a round; a peek at the app
// switcher or Notification Centre (iOS `inactive` alone) does not, since the user never left the page.
function subscribe(): () => void {
  let away = AppState.currentState === 'background'
  const change = AppState.addEventListener('change', (next) => {
    if (next === 'background') {
      away = true
    } else if (next === 'active' && away) {
      away = false
      announce(null)
    }
  })
  return () => change.remove()
}

// One numbered round per return, shared by every shell, so pages' answers are matched to the same ask.
export function onAppResumeRound(hostId: string, listener: RoundListener): () => void {
  listeners.set(listener, hostId)
  unsubscribe ??= subscribe()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      unsubscribe?.()
      unsubscribe = null
    }
  }
}

export function useAppResumeRounds(hostId: string, onRound: RoundListener): void {
  const onRoundRef = useRef(onRound)
  useLayoutEffect(() => {
    onRoundRef.current = onRound
  }, [onRound])
  useEffect(
    () => onAppResumeRound(hostId, (next, confirming) => onRoundRef.current(next, confirming)),
    [hostId]
  )
}

// Asks every page of this host again, in a fresh round, right before a reload.
export function askPagesAgain(hostId: string): number {
  return announce(hostId)
}

// The latest round any page was asked: answers to it or earlier are stale once the app leaves.
export function latestAppResumeRound(): number {
  return round
}
