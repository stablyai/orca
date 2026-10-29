import type { ReaderState } from './voice-native-module'

// Like a music player: Previous this soon after a start goes back a message, later it restarts.
export const RESTART_AFTER_MS = 3_000
const HISTORY_LENGTH = 10

/** `language`: a run in another language than the reading voice's, read with a voice for it. */
export type Piece = { kind: 'chime' } | { kind: 'text'; text: string; language?: string | null }

export type Utterance = {
  id: string
  pieces: Piece[]
  /** Shown in the notification and on a car's display. */
  title: string | null
  /** Queued by auto-read, which the headphones-only option can hold back. */
  auto: boolean
  /** Speech text without the intro: the same reply reaches the reader under different ids. */
  body: string
}

/**
 * `paused`: by the user, until they resume. `interrupted` (call, dictation) and `unplugged`
 * (headphones-only option, headphones or car gone) resume by themselves when that ends.
 */
export type Hold = { reason: 'paused' | 'interrupted' | 'unplugged'; since: number }

const HOLD_STATUS: Record<Hold['reason'], string> = {
  paused: 'Paused',
  interrupted: 'Paused for a call or dictation',
  unplugged: 'Paused until headphones are back'
}

/**
 * The notification's second line, under "Auto-read active" or "paused", e.g. "Reading · MobileApp
 * · 2 more waiting" or "2 waiting"; null while idle.
 */
export function readerStatus(
  state: ReaderState,
  hold: Hold | null,
  current: Utterance | null,
  waiting: number
): string | null {
  if (state === 'idle') {
    return null
  }
  const parts = hold ? [HOLD_STATUS[hold.reason]] : current ? ['Reading'] : []
  if (current?.title) {
    parts.push(current.title)
  }
  if (waiting > 0) {
    parts.push(current ? `${waiting} more waiting` : `${waiting} waiting`)
  }
  return parts.join(' · ') || null
}

/** A message read again keeps its place in the history. */
export function remembered(history: readonly Utterance[], utterance: Utterance): Utterance[] {
  const at = history.findIndex((kept) => kept.id === utterance.id)
  return at === -1
    ? [...history, utterance].slice(-HISTORY_LENGTH)
    : history.map((kept, index) => (index === at ? utterance : kept))
}

export function previousTarget(
  history: readonly Utterance[],
  playing: Utterance | null,
  playedForMs: number
): Utterance | undefined {
  if (playing === null) {
    return history.at(-1)
  }
  const at = history.findIndex((kept) => kept.id === playing.id)
  return playedForMs >= RESTART_AFTER_MS || at <= 0 ? playing : history[at - 1]
}

/** Whether Previous has a message to go back to; while idle the notification's Play repeats. */
export function canGoPrevious(
  history: readonly Utterance[],
  current: Utterance | null,
  waiting: number
): boolean {
  if (current === null) {
    // Messages wait while auto-read is paused; Previous reads the last one again.
    return waiting > 0 && history.length > 0
  }
  return history.findIndex((kept) => kept.id === current.id) > 0
}
