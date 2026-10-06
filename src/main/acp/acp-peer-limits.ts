import { isSafeTimerDelayMs } from '../../shared/timer-delay'

export function bounded(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('ACP limits must be positive finite integers')
  }
  return value
}

export function requestTimeout(value: number | null | undefined): number | null {
  if (value == null) {
    return null
  }
  if (!isSafeTimerDelayMs(value) || value <= 0) {
    throw new Error('ACP timeouts must be positive finite timer durations')
  }
  return value
}
