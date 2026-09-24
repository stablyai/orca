import { Worker } from 'node:worker_threads'
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
  type ProfileStateWriterInitialization
} from './profile-state-writer-protocol'

const REQUEST_TIMEOUT_MS = 30_000

/** One materialized command; Store owns coalescing and never queues snapshots here. */
export class ProfileStateWriterConnection {
  readonly ready: Promise<void>
  private worker: Worker | undefined
  private active: PendingProfileStateWriterRequest | undefined
  private nextId = 1
  private failure: Error | undefined
  private draining = false
  private closePromise: Promise<void> | undefined
  private readonly exit = Promise.withResolvers<void>()
  private didExit = false
  private closeAcknowledged = false
  private readonly timeoutMs: number
  private readonly initialRevision: number
  private latestRevision: number | undefined

  constructor(
    initialization: ProfileStateWriterInitialization,
    options: { workerPath?: string; timeoutMs?: number } = {}
  ) {
    this.initialRevision = initialization.revision
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
    const pending = this.createPending(0, 'initialize')
    this.active = pending
    this.ready = pending.promise.then(() => {})
    // Initialization failures remain observable through ready without an unhandled rejection.
    void this.ready.catch(() => {})
    try {
      const worker = new Worker(options.workerPath ?? resolveProfileStateWriterWorkerPath(), {
        workerData: initialization,
        execArgv: []
      })
      this.worker = worker
      worker.on('message', (response: unknown) => this.receive(response))
      worker.on('error', (cause: Error) =>
        this.fault(
          new ProfileStateWriterError(
            'profile-state-writer-exit',
            'Profile state writer failed',
            this.dispatchedOutcome(),
            { cause }
          )
        )
      )
      worker.once('exit', (code) => {
        this.didExit = true
        this.exit.resolve()
        if (!this.closeAcknowledged || code !== 0) {
          this.fault(
            new ProfileStateWriterError(
              'profile-state-writer-exit',
              `Profile state writer exited without a completed close (${code})`,
              this.dispatchedOutcome()
            )
          )
        }
      })
    } catch (cause) {
      this.didExit = true
      this.exit.resolve()
      this.fault(
        new ProfileStateWriterError(
          'profile-state-writer-unavailable',
          'Profile state writer could not start',
          'known-failure',
          { cause }
        )
      )
    }
  }

  /** Abandoning an active wait cannot establish whether SQLite committed. */
  async abort(): Promise<void> {
    this.fault(
      new ProfileStateWriterError(
        'profile-state-writer-aborted',
        'Profile state writer was aborted',
        this.dispatchedOutcome()
      )
    )
    await this.exit.promise
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

  private async finishClose(): Promise<void> {
    await this.active?.promise.catch(() => {})
    if (!this.failure && !this.didExit) {
      try {
        await this.dispatch({ command: 'close' })
      } finally {
        const timer = setTimeout(
          () =>
            this.fault(
              new ProfileStateWriterError(
                'profile-state-writer-close-timeout',
                'Profile state writer did not exit after close',
                'indeterminate'
              )
            ),
          this.timeoutMs
        )
        try {
          await this.exit.promise
        } finally {
          clearTimeout(timer)
        }
      }
      if (this.failure) {
        throw this.failure
      }
    } else {
      await this.exit.promise
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
      this.worker?.postMessage({ ...command, id: pending.id })
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
    return createProfileStateWriterRequest(id, command, this.timeoutMs, () =>
      this.fault(
        new ProfileStateWriterError(
          'profile-state-writer-timeout',
          'Profile state writer command timed out',
          this.dispatchedOutcome()
        )
      )
    )
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
    clearTimeout(pending.timer)
    if (response) {
      pending.resolve(response)
    } else {
      pending.reject(error ?? new Error('Profile state request failed'))
    }
  }

  private dispatchedOutcome(): 'known-failure' | 'indeterminate' {
    return this.active?.command === 'initialize' ? 'known-failure' : 'indeterminate'
  }

  private invalidResponse(): void {
    const error = new ProfileStateWriterError(
      'profile-state-writer-protocol',
      'Invalid profile state writer response',
      this.dispatchedOutcome()
    )
    this.fault(error)
  }

  private fault(error: Error): void {
    this.failure ??= error
    this.settle(undefined, this.failure)
    if (!this.didExit) {
      void this.worker?.terminate().catch(() => {})
    }
  }
}
