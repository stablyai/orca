import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import type { UseMobileDictationResult } from '../hooks/mobile-dictation-session-state'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { MobileDictationAwayTarget } from './mobile-dictation-away-insert'
import type { MobileDictationLiveText } from './use-mobile-dictation-announcements'
import type { DictationTerm } from '../../../src/shared/dictation-dictionary'
import type { StopAfterSilenceSeconds } from '../../../src/shared/dictation-silence-stop'

export type MobileDictationHostToast = { message: string; open?: () => void }

// Who started the dictation and where its words go, fixed at the tap: leaving the screen never moves them.
export type MobileDictationOwner = {
  // The starting screen instance, and the session it shows (a reopened screen of that session takes over its controls).
  readonly instance: object
  readonly sessionKey: string
  readonly client: RpcClient | null
  readonly target: MobileDictationAwayTarget
  // The target tab's title, for the pill and its toasts.
  readonly title: string
  // The session route that opens the target tab again when its screen is gone.
  readonly href: string
  // The target tab's pane key, for a screen still in the stack to switch back to it.
  readonly paneKey: string | undefined
  readonly dictationMode: string | undefined
  readonly silenceSeconds: StopAfterSilenceSeconds
  readonly removeFillerWords: boolean
  // The computer's terms for this worktree, for words the phone recognizes itself.
  readonly dictationTerms: readonly DictationTerm[] | undefined
  // The computer spells its own words with this worktree's repo terms.
  readonly worktreeId: string
  // The computer that would transcribe it, for what a screen reader hears; null when the phone lacks its name.
  readonly computerName: string | null
}

// A mounted session screen, as the dictation host sees it.
export type MobileDictationScreen = {
  readonly instance: object
  readonly sessionKey: string
  // The one "shown" rule (mobile-dictation-shown.ts): true while the in-place controls stand for the dictation.
  readonly shown: () => boolean
  // The starting screen inserts where it started (cursor, live input); false when it cannot, so the host inserts instead.
  readonly insert: (text: string, heard: { partial: boolean }) => boolean
  // Setup refusals open its setup sheet; other failures toast on it.
  readonly reportFailure: (err: Error) => void
  readonly toast: (message: string) => void
  // Pop the screens above this one and show the target tab.
  readonly bringToFront: (paneKey: string | undefined) => void
}

// Stable across the dictation's ticks: screens read the live dictation through subscribe, so a word heard re-renders only who shows it.
export type MobileDictationHost = {
  readonly owner: MobileDictationOwner | null
  readonly start: (owner: MobileDictationOwner) => Promise<void>
  // Stop with the selection tick, as every stop button does.
  readonly stop: () => void
  // Say something to the screen reader; a screen's own toast is not read on the page.
  readonly announce: (message: string) => void
  readonly attach: (screen: MobileDictationScreen) => () => void
  // A screen's shown() answer changed; the pill reads it on render.
  readonly refresh: () => void
  readonly subscribe: (listener: () => void) => () => void
  readonly getDictation: () => UseMobileDictationResult
  // The same dictation as nobody's: no status, words or failure; its identity holds until the meter or callbacks change.
  readonly getIdleDictation: () => UseMobileDictationResult
  // Starting, recording, finishing, or a failure kept for Retry.
  readonly getUnderway: () => boolean
}

// The floating pill's own state, apart from the host's so a bar height or toast re-renders only the pill.
export type MobileDictationPill = {
  // Shown while the dictation's own screen is not.
  readonly away: boolean
  readonly title: string
  readonly open: () => void
  readonly toast: MobileDictationHostToast | null
  readonly clearToast: () => void
  // The tallest bottom bar a screen reported, so the pill floats above it.
  readonly clearance: number
  // Announcements the shell could not speak, for the page's live region (TalkBack, older shells).
  readonly liveText: MobileDictationLiveText
}

export const MobileDictationHostContext = createContext<MobileDictationHost | null>(null)
export const MobileDictationPillContext = createContext<MobileDictationPill | null>(null)

export function useMobileDictationHost(): MobileDictationHost {
  const host = useContext(MobileDictationHostContext)
  if (!host) {
    throw new Error('useMobileDictationHost needs a MobileDictationHostProvider')
  }
  return host
}

// The live dictation, re-rendering on each of its changes.
export function useMobileDictationHostLive(host: MobileDictationHost): UseMobileDictationResult {
  return useSyncExternalStore(host.subscribe, host.getDictation)
}

// Bottom bars report the height they cover, so the pill floats above them rather than over their buttons.
export const MobileDictationClearanceContext = createContext<
  ((id: symbol, height: number) => void) | null
>(null)

// A bottom bar's covered height, cleared when it unmounts; a hidden screen's bar lays out at zero.
export function useMobileDictationClearance(height: number): void {
  const setClearance = useContext(MobileDictationClearanceContext)
  const [id] = useState(() => Symbol('dictation-clearance'))
  useEffect(() => {
    setClearance?.(id, height)
  }, [height, id, setClearance])
  useEffect(() => () => setClearance?.(id, 0), [id, setClearance])
}
