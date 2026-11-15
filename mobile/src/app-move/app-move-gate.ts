import { useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import { OrcaPlayStorePresence } from '../../modules/orca-play-store-presence/src'
import { isRetiredGithubAndroidApp } from '../app-update/app-update-runtime'
import { loadKeptRetiredAppAt, saveKeptRetiredAppAt } from '../storage/app-update-preferences'

export type AppMoveScreen = 'play' | 'download'

export type AppMoveState = {
  readonly screen: AppMoveScreen | null
  /** Screen 2 reached from screen 1, so it offers a way back. */
  readonly cameFromPlay: boolean
}

const REMIND_AFTER_MS = 7 * 24 * 60 * 60 * 1000

// Checked once: the native call is cheap, and an install mid-session is rare.
export const playStoreAvailable: boolean =
  isRetiredGithubAndroidApp && (OrcaPlayStorePresence?.isPlayStoreInstalled() ?? true)

const listeners = new Set<() => void>()
let state: AppMoveState = { screen: null, cameFromPlay: false }
let keptAt: number | null = null
let loaded = false
// A notification tap opens the agent, not this screen; the next normal open shows it.
let skipThisOpen = false
let started = false

function setState(next: AppMoveState): void {
  state = next
  for (const listener of listeners) {
    listener()
  }
}

function deviceScreen(): AppMoveScreen {
  return playStoreAvailable ? 'play' : 'download'
}

function showIfDue(): void {
  const due = keptAt === null || Date.now() - keptAt >= REMIND_AFTER_MS
  if (loaded && due && !skipThisOpen && state.screen === null) {
    setState({ screen: deviceScreen(), cameFromPlay: false })
  }
}

/** Shows the move screen on each normal open of the retired GitHub app. */
export function startAppMoveGate(launchedFromNotification: boolean): void {
  if (!isRetiredGithubAndroidApp || started) {
    return
  }
  started = true
  skipThisOpen = launchedFromNotification
  let previous: string | null | undefined = AppState.currentState
  AppState.addEventListener('change', (next) => {
    if (next === 'background') {
      skipThisOpen = false
    } else if (next === 'active' && previous === 'background') {
      showIfDue()
    }
    previous = next
  })
  void loadKeptRetiredAppAt().then((value) => {
    keptAt = value
    loaded = true
    showIfDue()
  })
}

/** A notification tap opens its agent; the screen waits for the next normal open. */
export function skipAppMoveForNotification(): void {
  skipThisOpen = true
  setState({ screen: null, cameFromPlay: false })
}

export function openAppMoveScreen(): void {
  setState({ screen: deviceScreen(), cameFromPlay: false })
}

export function openDownloadFromPlayScreen(): void {
  setState({ screen: 'download', cameFromPlay: true })
}

export function returnToPlayScreen(): void {
  setState({ screen: 'play', cameFromPlay: false })
}

export function keepRetiredApp(): void {
  keptAt = Date.now()
  void saveKeptRetiredAppAt(keptAt).catch(() => {})
  setState({ screen: null, cameFromPlay: false })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useAppMoveState(): AppMoveState {
  return useSyncExternalStore(subscribe, () => state)
}
