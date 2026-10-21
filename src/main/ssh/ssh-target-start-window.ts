import { isAuthError } from './ssh-reconnect-error-classification'
import { isHostKeyVerificationError } from './ssh-host-key-decision'
import { sleep } from './connection/ssh-connection-timing'

// A provider reports running when its host starts, before sshd accepts; dials redial briefly.
const FRESH_START_WINDOW_MS = 60_000
const FRESH_START_REDIAL_DELAYS_MS: readonly number[] = [2_000, 6_000, 12_000]

/**
 * SSH targets whose host is starting (a machine waking) or just started. Every dial to one, the
 * machine connect and the managed server tunnel alike, waits for the start and then redials.
 */
export class SshTargetStartWindow {
  private readonly starting = new Map<string, Promise<unknown>>()
  private readonly startedAt = new Map<string, number>()
  private readonly changedAt = new Map<string, number>()

  constructor(
    private readonly clock: {
      now: () => number
      delay: (ms: number) => Promise<void>
    } = { now: Date.now, delay: sleep }
  ) {}

  noteStarting(targetId: string, start: Promise<unknown>): void {
    this.changedAt.set(targetId, this.clock.now())
    this.starting.set(targetId, start)
    const settle = (): void => {
      if (this.starting.get(targetId) === start) {
        this.starting.delete(targetId)
      }
    }
    start.then(settle, settle)
  }

  noteStarted(targetId: string): void {
    this.startedAt.set(targetId, this.clock.now())
    this.changedAt.set(targetId, this.clock.now())
  }

  noteStopped(targetId: string): void {
    this.startedAt.delete(targetId)
    this.changedAt.set(targetId, this.clock.now())
  }

  /** Whether the host stopped or started after `at`, so what it answered then proves nothing now. */
  changedSince(targetId: string, at: number): boolean {
    return (this.changedAt.get(targetId) ?? -Infinity) >= at
  }

  /**
   * Dials once any start in flight settles, redialing within the start window. Nothing is awaited
   * before an idle target's first dial, so callers that coalesce dials still see it at once.
   * `isFinal` marks failures that are the caller's own verdict rather than a slow start.
   */
  async dial<T>(
    targetId: string | undefined,
    dial: () => Promise<T>,
    isFinal?: (error: unknown) => boolean
  ): Promise<T> {
    // A failed start is not the dial's answer; the dial reports what it meets.
    const start = targetId ? this.starting.get(targetId)?.catch(() => undefined) : undefined
    if (start) {
      await start
    }
    const delays = targetId ? this.redialDelays(targetId) : []
    for (let attempt = 0; ; attempt++) {
      try {
        return await dial()
      } catch (error) {
        const delay = delays[attempt]
        if (delay === undefined || !isSshStartRedialable(error) || isFinal?.(error)) {
          throw error
        }
        await this.clock.delay(delay)
      }
    }
  }

  private redialDelays(targetId: string): readonly number[] {
    const at = this.startedAt.get(targetId)
    return at !== undefined && this.clock.now() - at < FRESH_START_WINDOW_MS
      ? FRESH_START_REDIAL_DELAYS_MS
      : []
  }
}

export const sshTargetStarts = new SshTargetStartWindow()

/** A refused host key or credential is a verdict, never a slow start. */
export function isSshStartRedialable(error: unknown): boolean {
  if (isHostKeyVerificationError(error)) {
    return false
  }
  const failure = error instanceof Error ? error : new Error(String(error))
  return !isAuthError(failure) && !/host key verification failed/i.test(failure.message)
}
