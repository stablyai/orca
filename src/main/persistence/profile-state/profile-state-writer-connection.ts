import { resolveProfileStateWriterWorkerPath } from './profile-state-writer-worker-path'
import {
  createProfileStateWriterRequest,
  isExpectedProfileStateWriterSuccess,
  type PendingProfileStateWriterRequest,
  type SuccessfulProfileStateWriterResponse
} from './profile-state-writer-request'
import {
  decodeProfileStateWriterError,
  ProfileStateWriterError
} from './profile-state-writer-errors'
import {
  isProfileStateWriterResponse,
  type ProfileStateWriterCommand,
  type ProfileStateWriterFailureOutcome,
  type ProfileStateWriterInitialization
} from './profile-state-writer-protocol'
import { recordProfileStateWriterFault } from './profile-state-writer-diagnostics'
import {
  PROFILE_STATE_WRITER_SLOW_WARNING_MS,
  startProfileStateWriterSlowWarning
} from './profile-state-writer-slow-warning'
import { ProfileStateWriterThread } from './profile-state-writer-thread'

export type ProfileStateWriterConnectionOptions = {
  workerPath?: string
  /** Delay before one diagnostic breadcrumb; never fails the request. */
  slowWarningMs?: number
  onFailure?: (error: Error) => void
  onSaveDelayChanged?: (delayed: boolean) => void
  reportInitializationFailure?: boolean
  /** Monotonic milliseconds; tests replace it to model a stalled main loop. */
  clock?: () => number
}

/** One materialized command; Store owns coalescing and never queues snapshots here. */
export class ProfileStateWriterConnection {
  readonly ready: Promise<void>
  private thread: ProfileStateWriterThread | undefined
  private active: PendingProfileStateWriterRequest | undefined
  private nextId = 1
  private failure: Error | undefined
  private draining = false
  private closePromise: Promise<void> | undefined
  private closeAcknowledged = false
  private saveDelayed = false
  private readonly slowWarningMs: number
  private readonly initialRevision: number
  private latestRevision: number | undefined

  constructor(
    initialization: ProfileStateWriterInitialization,
    private readonly options: ProfileStateWriterConnectionOptions = {}
  ) {
    this.initialRevision = initialization.revision
    this.slowWarningMs = options.slowWarningMs ?? PROFILE_STATE_WRITER_SLOW_WARNING_MS
    const pending = this.createPending(0, 'initialize')
    this.active = pending
    this.ready = pending.promise.then(() => {})
    // Initialization failures remain observable through ready without an unhandled rejection.
    void this.ready.catch(() => {})
    try {
      this.thread = new ProfileStateWriterThread(
        options.workerPath ?? resolveProfileStateWriterWorkerPath(),
        initialization,
        {
          message: (response) => this.receive(response),
          error: (cause) =>
            this.faultWith('profile-state-writer-exit', 'Profile state writer failed', { cause }),
          exit: (code) => {
            if (!this.closeAcknowledged || code !== 0) {
              const message = `Profile state writer exited without a completed close (${code})`
              this.faultWith('profile-state-writer-exit', message, { exitCode: code })
            }
          }
        }
      )
    } catch (cause) {
      this.faultWith('profile-state-writer-unavailable', 'Profile state writer could not start', {
        cause,
        outcome: 'known-failure'
      })
    }
  }

  /** Abandoning an active wait cannot establish whether SQLite committed. */
  async abort(): Promise<void> {
    this.faultWith('profile-state-writer-aborted', 'Profile state writer was aborted')
    await this.thread?.exitPromise
  }

  stopAdmission(): void {
    this.draining = true
  }

  close(): Promise<void> {
    this.stopAdmission()
    this.closePromise ??= this.finishClose()
    return this.closePromise
  }

  get acknowledgedRevision(): number {
    if (this.failure) {
      throw this.failure
    }
    if (this.latestRevision === undefined) {
      throw new Error('Profile state writer has no acknowledged revision')
    }
    return this.latestRevision
  }

  /** The last revision this worker confirmed, kept after a fault for diagnostics. */
  get lastAcknowledgedRevision(): number {
    return this.latestRevision ?? this.initialRevision
  }

  private get didExit(): boolean {
    return this.thread?.exited ?? true
  }

  private async finishClose(): Promise<void> {
    await this.active?.promise.catch(() => {})
    if (!this.failure && !this.didExit) {
      const closeRequestId = this.nextId
      try {
        await this.dispatch({ command: 'close' })
      } finally {
        // Neither elapsed time nor a termination request proves exit; ownership waits for it.
        await this.awaitExit(closeRequestId)
      }
      if (this.failure) {
        throw this.failure
      }
    } else {
      await this.thread?.exitPromise
    }
  }

  private async awaitExit(requestId: number): Promise<void> {
    const thread = this.thread
    if (!thread || thread.exited) {
      return
    }
    const clearSlowWarning = startProfileStateWriterSlowWarning({
      warningMs: this.slowWarningMs,
      phase: 'awaiting-exit',
      now: this.options.clock,
      request: {
        command: 'close',
        requestId,
        acknowledgedRevision: this.lastAcknowledgedRevision
      }
    })
    try {
      await thread.exitPromise
    } finally {
      clearSlowWarning()
    }
  }

  protected assertDispatchable(closing = false): void {
    if (this.failure) {
      throw this.failure
    }
    if (this.didExit || (this.draining && !closing)) {
      throw new ProfileStateWriterError(
        'profile-state-writer-closed',
        'Profile state writer is closing',
        'known-failure'
      )
    }
    if (this.active) {
      throw new ProfileStateWriterError(
        'profile-state-writer-busy',
        'Await the active profile state command before dispatching another snapshot',
        'known-failure'
      )
    }
  }

  protected dispatch(
    command: ProfileStateWriterCommand
  ): Promise<SuccessfulProfileStateWriterResponse> {
    try {
      this.assertDispatchable(command.command === 'close')
    } catch (error) {
      return Promise.reject(error)
    }
    const pending = this.createPending(this.nextId++, command.command)
    this.active = pending
    try {
      this.thread?.post({ ...command, id: pending.id })
    } catch (cause) {
      // postMessage did not dispatch a message when serialization fails.
      this.settle(
        undefined,
        new ProfileStateWriterError(
          'profile-state-writer-message',
          'Profile state command could not be transferred',
          'known-failure',
          { cause }
        )
      )
    }
    return pending.promise
  }

  private createPending(
    id: number,
    command: PendingProfileStateWriterRequest['command']
  ): PendingProfileStateWriterRequest {
    return createProfileStateWriterRequest(id, command, this.slowWarningMs, {
      now: this.options.clock,
      acknowledgedRevision: this.lastAcknowledgedRevision,
      onSlow: () => {
        // Revision checks and exports occupy the same worker and can hold up later saves.
        if (this.active?.id === id && command !== 'initialize' && command !== 'close') {
          this.reportSaveDelay(true)
        }
      }
    })
  }

  private reportSaveDelay(delayed: boolean): void {
    if (this.saveDelayed === delayed) {
      return
    }
    this.saveDelayed = delayed
    try {
      this.options.onSaveDelayChanged?.(delayed)
    } catch (error) {
      console.error('[persistence] Could not report delayed saving:', error)
    }
  }

  private receive(value: unknown): void {
    if (this.failure) {
      return
    }
    const pending = this.active
    if (!isProfileStateWriterResponse(value) || !pending || value.id !== pending.id) {
      this.invalidResponse()
      return
    }
    if (!value.ok) {
      const error = decodeProfileStateWriterError(value.error)
      if (pending.command === 'initialize' || value.error.outcome === 'indeterminate') {
        this.fault(error)
      } else {
        this.settle(undefined, error)
      }
      return
    }
    if (
      !isExpectedProfileStateWriterSuccess(
        pending.command,
        value,
        this.latestRevision ?? this.initialRevision
      )
    ) {
      this.invalidResponse()
      return
    }
    if (pending.command === 'close') {
      this.closeAcknowledged = true
    }
    this.latestRevision = value.revision
    this.settle(value)
  }

  private settle(response?: SuccessfulProfileStateWriterResponse, error?: Error): void {
    const pending = this.active
    this.active = undefined
    if (!pending) {
      return
    }
    pending.clearSlowWarning()
    this.reportSaveDelay(false)
    if (response) {
      pending.resolve(response)
    } else {
      pending.reject(error ?? new Error('Profile state request failed'))
    }
  }

  private dispatchedOutcome(): ProfileStateWriterFailureOutcome {
    return this.active?.command === 'initialize' ? 'known-failure' : 'indeterminate'
  }

  private invalidResponse(): void {
    this.faultWith('profile-state-writer-protocol', 'Invalid profile state writer response')
  }

  private faultWith(
    code: string,
    message: string,
    {
      cause,
      exitCode,
      outcome = this.dispatchedOutcome()
    }: { cause?: unknown; exitCode?: number; outcome?: ProfileStateWriterFailureOutcome } = {}
  ): void {
    const options = cause === undefined ? undefined : { cause }
    this.fault(new ProfileStateWriterError(code, message, outcome, options), exitCode)
  }

  private fault(error: Error, exitCode?: number): void {
    if (this.failure) {
      return
    }
    this.failure = error
    recordProfileStateWriterFault(error, this.active, this.lastAcknowledgedRevision, exitCode)
    this.settle(undefined, error)
    this.thread?.terminate()
    // Startup failures already reject ready; admitted writers must also alert idle callers.
    if (this.latestRevision !== undefined || this.options.reportInitializationFailure) {
      try {
        this.options.onFailure?.(error)
      } catch (notificationError) {
        console.error('[persistence] Could not report stopped saving:', notificationError)
      }
    }
  }
}
