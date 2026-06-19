import { spawn as nodeSpawn } from 'node:child_process'

export const LINUX_LID_SLEEP_ASSERTION_RETRY_MS = 30_000

type Logger = Pick<Console, 'debug' | 'warn'>

type SystemdInhibitErrorListener = (error: Error & { code?: string }) => void
type SystemdInhibitExitListener = (code: number | null, signal: NodeJS.Signals | null) => void

type SystemdInhibitProcess = {
  kill: () => boolean
  on(event: 'error', listener: SystemdInhibitErrorListener): void
  on(event: 'exit', listener: SystemdInhibitExitListener): void
  off(event: 'error', listener: SystemdInhibitErrorListener): void
  off(event: 'exit', listener: SystemdInhibitExitListener): void
  pid?: number
}

type SystemdInhibitSpawn = (
  command: string,
  args: string[],
  options: { stdio: 'ignore'; windowsHide: true; shell?: false }
) => SystemdInhibitProcess

type LinuxLidSleepAssertionOptions = {
  logger?: Logger
  now?: () => number
  onUnexpectedFailure?: (reason: string) => void
  platform?: NodeJS.Platform
  spawn?: SystemdInhibitSpawn
}

export class LinuxLidSleepAssertion {
  private readonly logger: Logger
  private readonly now: () => number
  private readonly onUnexpectedFailure: (reason: string) => void
  private readonly platform: NodeJS.Platform
  private readonly spawn: SystemdInhibitSpawn
  private child: SystemdInhibitProcess | null = null
  private retryNotBefore: number | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private systemdInhibitUnavailable = false
  private lastFailureKey: string | null = null
  private warnedForLastFailure = false
  private readonly intentionalStops = new WeakSet<SystemdInhibitProcess>()
  private readonly reportedFailures = new WeakSet<SystemdInhibitProcess>()
  private readonly childCleanups = new WeakMap<SystemdInhibitProcess, () => void>()

  constructor(options: LinuxLidSleepAssertionOptions = {}) {
    this.logger = options.logger ?? console
    this.now = options.now ?? Date.now
    this.onUnexpectedFailure = options.onUnexpectedFailure ?? (() => {})
    this.platform = options.platform ?? process.platform
    this.spawn = options.spawn ?? nodeSpawn
  }

  start(reason: string): void {
    if (this.platform !== 'linux' || this.child || this.systemdInhibitUnavailable) {
      return
    }
    if (this.retryNotBefore !== null && this.now() < this.retryNotBefore) {
      this.scheduleRetry()
      return
    }

    let child: SystemdInhibitProcess
    try {
      // logind's lid switch handling ignores ordinary sleep inhibitors on many systems,
      // so Linux needs both a sleep lock and a handle-lid-switch lock.
      child = this.spawn(
        'systemd-inhibit',
        [
          '--what=sleep:handle-lid-switch',
          '--who=Orca',
          '--why=Agents are working',
          '--mode=block',
          'sleep',
          'infinity'
        ],
        {
          stdio: 'ignore',
          windowsHide: true
        }
      )
    } catch (error) {
      this.handleFailure('spawn-error', reason, error, 'spawn-error')
      return
    }

    this.child = child
    const onError: SystemdInhibitErrorListener = (error) => {
      this.handleChildFailure(
        child,
        `error:${String(error.code ?? error.message)}`,
        'error',
        reason,
        error
      )
    }
    const onExit: SystemdInhibitExitListener = (code, signal) => {
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
        this.logger.warn('[agent-awake] failed to stop Linux lid sleep assertion', { error })
      }
    }
  }

  dispose(): void {
    this.stop('dispose')
  }

  private handleChildFailure(
    child: SystemdInhibitProcess,
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

  private detachChildListeners(child: SystemdInhibitProcess): void {
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
    failureType: 'error' | 'exit' | 'spawn-error'
  ): void {
    if (isMissingSystemdInhibit(details)) {
      this.systemdInhibitUnavailable = true
      this.resetRetrySuppression()
      this.logFailure('systemd-inhibit-missing', reason, details, failureType)
      return
    }
    this.logFailure(failureKey, reason, details, failureType)
    this.retryNotBefore = this.now() + LINUX_LID_SLEEP_ASSERTION_RETRY_MS
    this.scheduleRetry()
    this.onUnexpectedFailure('linux-lid-assertion-failure')
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
      this.logger.debug('[agent-awake] Linux lid sleep assertion failed repeatedly', payload)
      return
    }
    this.lastFailureKey = failureKey
    this.warnedForLastFailure = true
    this.logger.warn('[agent-awake] Linux lid sleep assertion failed', payload)
  }

  private resetFailureStreak(): void {
    this.lastFailureKey = null
    this.warnedForLastFailure = false
  }

  private scheduleRetry(): void {
    if (this.retryNotBefore === null || this.retryTimer) {
      return
    }
    const retryDelay = Math.max(0, this.retryNotBefore - this.now())
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.onUnexpectedFailure('linux-lid-assertion-retry')
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
}

function isMissingSystemdInhibit(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

function isEsrchError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ESRCH'
  )
}
