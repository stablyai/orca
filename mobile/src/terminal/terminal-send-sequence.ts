// Why: enough to keep a fast typist or a long drag moving across a one-second round trip, small enough that a dead link strands only a handful of requests.
export const TERMINAL_SEND_WINDOW = 8

/** Input sources that keep their own order: typed text never waits behind touch gestures. */
export type TerminalSendLane = 'keys' | 'gestures'

export type TerminalSendSequence = { readonly stream: string; readonly seq: number }

// Why: one stalled reply must not slow scrolling for the rest of the session.
const MAX_PACED_ROUND_TRIP_MS = 1000

export type TerminalSendSequenceState = {
  hostOrdersSends: boolean
  roundTripMs: number | null
  readonly streams: Map<string, { stream: string; seq: number }>
}

export function createTerminalSendSequenceState(): TerminalSendSequenceState {
  return { hostOrdersSends: false, roundTripMs: null, streams: new Map() }
}

export function setHostOrdersTerminalSends(
  state: TerminalSendSequenceState,
  hostOrdersSends: boolean
): void {
  state.hostOrdersSends = hostOrdersSends
  state.roundTripMs = null
  // Why: a different host has never seen these streams.
  state.streams.clear()
}

/** How many sends one lane may have outstanding: several only when the host applies them in order. */
export function terminalSendWindow(state: TerminalSendSequenceState): number {
  return state.hostOrdersSends ? TERMINAL_SEND_WINDOW : 1
}

export function noteTerminalSendRoundTrip(
  state: TerminalSendSequenceState,
  sampleMs: number
): void {
  const sample = Math.min(Math.max(0, sampleMs), MAX_PACED_ROUND_TRIP_MS)
  state.roundTripMs = state.roundTripMs === null ? sample : state.roundTripMs * 0.75 + sample * 0.25
}

/**
 * The gap to leave between sends that supersede each other, so a window lasts the whole round
 * trip instead of leaving in one burst followed by a pause as long as the link is slow.
 */
export function terminalSendSpacingMs(state: TerminalSendSequenceState): number {
  return state.hostOrdersSends && state.roundTripMs !== null
    ? state.roundTripMs / TERMINAL_SEND_WINDOW
    : 0
}

function laneKey(lane: TerminalSendLane, handle: string): string {
  return `${lane}\u0000${handle}`
}

/** Call immediately before the request is written: a number that never reaches the wire stalls the host for its gap hold. */
export function nextTerminalSendSequence(
  state: TerminalSendSequenceState,
  lane: TerminalSendLane,
  handle: string
): TerminalSendSequence | undefined {
  if (!state.hostOrdersSends) {
    return undefined
  }
  const key = laneKey(lane, handle)
  let current = state.streams.get(key)
  if (!current) {
    // Why: the host remembers streams by name, so a restarted app must never reuse one.
    const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
    current = { stream: `${lane}-${unique}`, seq: 0 }
    state.streams.set(key, current)
  }
  current.seq += 1
  return { stream: current.stream, seq: current.seq }
}

/** After a send whose delivery is unknown, later sends must not wait on its number. */
export function restartTerminalSendStream(
  state: TerminalSendSequenceState,
  lane: TerminalSendLane,
  handle: string
): void {
  state.streams.delete(laneKey(lane, handle))
}
