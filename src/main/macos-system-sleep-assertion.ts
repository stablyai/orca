import { spawn as nodeSpawn } from 'node:child_process'

export const MACOS_SYSTEM_SLEEP_ASSERTION_RETRY_MS = 30_000

type Logger = Pick<Console, 'debug' | 'warn'>

type CaffeinateErrorListener = (error: Error) => void
type CaffeinateExitListener = (code: number | null, signal: NodeJS.Signals | null) => void

type CaffeinateProcess = {
  kill: () => boolean
  on(event: 'error', listener: CaffeinateErrorListener): void
  on(event: 'exit', listener: CaffeinateExitListener): void
  off(event: 'error', listener: CaffeinateErrorListener): void
  off(event: 'exit', listener: CaffeinateExitListener): void
  pid?: number
}

type CaffeinateSpawn = (
  command: string,
  args: string[],
  options: { stdio: 'ignore'; windowsHide: true; shell?: false }
) => CaffeinateProcess

type MacosSystemSleepAssertionOptions = {
  logger?: Logger
  now?: () => number
  onUnexpectedFailure?: (reason: string) => void
  platform?: NodeJS.Platform
  spawn?: CaffeinateSpawn
}

export class MacosSystemSleepAssertion {
  private readonly logger: Logger
  private readonly now: () => number
  private readonly onUnexpectedFailure: (reason: string) => void
  private readonly platform: NodeJS.Platform
  private readonly spawn: CaffeinateSpawn
  private child: CaffeinateProcess | null = null
  private retryNotBefore: number | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private lastFailureKey: string | null = null
  private warnedForLastFailure = false
  private readonly intentionalStops = new WeakSet<CaffeinateProcess>()
  private readonly reportedFailures = new WeakSet<CaffeinateProcess>()
  private readonly childCleanups = new WeakMap<CaffeinateProcess, () => void>()

  constructor(options: MacosSystemSleepAssertionOptions = {}) {
    this.logger = options.logger ?? console
    this.now = options.now ?? Date.now
    this.onUnexpectedFailure = options.onUnexpectedFailure ?? (() => {})
    this.platform = options.platform ?? process.platform
    this.spawn = options.spawn ?? nodeSpawn
  }

  start(reason: string): void {
    if (this.platform !== 'darwin' || this.child) {
      return
    }
    if (this.retryNotBefore !== null && this.now() < this.retryNotBefore) {
      this.scheduleRetry()
      return
    }

    let child: CaffeinateProcess
    try {
      child = this.spawn('/usr/bin/caffeinate', ['-i', '-s'], {
        stdio: 'ignore',
        windowsHide: true
      })
    } catch (error) {
      this.handleFailure('spawn-error', reason, error)
      return
    }

    this.child = child
    const onError: CaffeinateErrorListener = (error) => {
      this.handleChildFailure(child, `error:${String(error.message)}`, 'error', reason, error)
    }
    const onExit: CaffeinateExitListener = (code, signal) => {
      this.handleChildFailure(child, `exit:${String(code)}:${String(signal)}`, 'exit', reason, {
        code,
        signal
      })
    }
    this.childCleanups.set(child, () => {
      child.off('error', onError)
      child.off('exit', onExit)
    })
    child.on('error', onError)
    child.on('exit', onExit)
    this.resetRetrySuppression()
    this.resetFailureStreak()
  }

  stop(_reason: string): void {
    this.resetRetrySuppression()
    this.resetFailureStreak()
    if (!this.child) {
      return
    }
    const child = this.child
    this.child = null
    this.intentionalStops.add(child)
    this.detachChildListeners(child)
    try {
      child.kill()
    } catch (error) {
      if (!isEsrchError(error)) {
        this.logger.warn('[agent-awake] failed to stop macOS system sleep assertion', {
          error
        })
      }
    }
  }

  dispose(): void {
    this.stop('dispose')
  }

  private handleChildFailure(
    child: CaffeinateProcess,
    failureKey: string,
    failureType: 'error' | 'exit',
    startReason: string,
    details: unknown
  ): void {
    this.detachChildListeners(child)
    if (this.intentionalStops.has(child)) {
      this.intentionalStops.delete(child)
      return
    }
    if (this.reportedFailures.has(child)) {
      return
    }
    this.reportedFailures.add(child)
    if (this.child === child) {
      this.child = null
    }
    this.handleFailure(failureKey, startReason, details, failureType)
  }

  private detachChildListeners(child: CaffeinateProcess): void {
    const cleanup = this.childCleanups.get(child)
    if (!cleanup) {
      return
    }
    cleanup()
    this.childCleanups.delete(child)
  }

  private handleFailure(
    failureKey: string,
    reason: string,
    details: unknown,
    failureType: 'error' | 'exit' | 'spawn-error' = 'spawn-error'
  ): void {
    this.logFailure(failureKey, reason, details, failureType)
    this.retryNotBefore = this.now() + MACOS_SYSTEM_SLEEP_ASSERTION_RETRY_MS
    this.scheduleRetry()
    this.onUnexpectedFailure('macos-assertion-failure')
  }

  private logFailure(
    failureKey: string,
    reason: string,
    details: unknown,
    failureType: 'error' | 'exit' | 'spawn-error'
  ): void {
    const payload = {
      reason,
      failureType,
      details
    }
    if (this.lastFailureKey === failureKey && this.warnedForLastFailure) {
      this.logger.debug('[agent-awake] macOS system sleep assertion failed repeatedly', payload)
      return
    }
    this.lastFailureKey = failureKey
    this.warnedForLastFailure = true
    this.logger.warn('[agent-awake] macOS system sleep assertion failed', payload)
  }

  private scheduleRetry(): void {
    if (this.retryNotBefore === null || this.retryTimer) {
      return
    }
    const retryDelay = Math.max(0, this.retryNotBefore - this.now())
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.onUnexpectedFailure('macos-assertion-retry')
    }, retryDelay)
    if (typeof this.retryTimer.unref === 'function') {
      this.retryTimer.unref()
    }
  }

  private resetRetrySuppression(): void {
    this.retryNotBefore = null
    if (!this.retryTimer) {
      return
    }
    clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private resetFailureStreak(): void {
    this.lastFailureKey = null
    this.warnedForLastFailure = false
  }
}

function isEsrchError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ESRCH'
  )
}
