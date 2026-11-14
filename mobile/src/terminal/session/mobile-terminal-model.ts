export type MobileDisplayMode = 'auto' | 'phone' | 'desktop'

export type TerminalGestureInputBucket = {
  tokens: number
  lastRefillMs: number
}

export type TerminalGestureInputQueue = {
  bytes: string
  sequenceCount: number
  timer: ReturnType<typeof setTimeout> | null
  lastUpdatedMs: number
}
