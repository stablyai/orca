export const STRUCTURED_BACKGROUND_RECONNECT_MS = 10_000
export const STRUCTURED_STREAM_STABLE_MS = 5_000

export type MobileStructuredReconnectState = {
  backgroundedAt: number | null
  streamOpenedAt: number | null
  backoffAttempt: number
}

export function createMobileStructuredReconnectState(): MobileStructuredReconnectState {
  return { backgroundedAt: null, streamOpenedAt: null, backoffAttempt: 0 }
}

export function noteStructuredBackground(state: MobileStructuredReconnectState, now: number): void {
  state.backgroundedAt ??= now
}

export function resumeStructuredSession(
  state: MobileStructuredReconnectState,
  now: number
): { reconnect: boolean; minimumBackoffAttempt: number } {
  const elapsed = state.backgroundedAt === null ? 0 : now - state.backgroundedAt
  state.backgroundedAt = null
  if (elapsed < STRUCTURED_BACKGROUND_RECONNECT_MS) {
    return { reconnect: false, minimumBackoffAttempt: state.backoffAttempt }
  }
  state.backoffAttempt = Math.max(1, state.backoffAttempt)
  return { reconnect: true, minimumBackoffAttempt: state.backoffAttempt }
}

export function noteStructuredStreamOpened(
  state: MobileStructuredReconnectState,
  now: number
): void {
  state.streamOpenedAt = now
}

export function noteStructuredStreamClosed(
  state: MobileStructuredReconnectState,
  now: number
): void {
  if (state.streamOpenedAt !== null && now - state.streamOpenedAt > STRUCTURED_STREAM_STABLE_MS) {
    state.backoffAttempt = 0
  } else {
    state.backoffAttempt++
  }
  state.streamOpenedAt = null
}

export function scheduleStructuredStreamLongevityConfirmation(confirm: () => void): () => void {
  const timer = setTimeout(confirm, STRUCTURED_STREAM_STABLE_MS + 1)
  return () => clearTimeout(timer)
}
