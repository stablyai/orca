import { AsyncLocalStorage } from 'node:async_hooks'
import { assertProfileLifetimeAdmission } from './profile-lifetime-admission'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'

type WorkEntry = {
  done: Promise<void>
  finish: () => void
  resource?: object
  failure?: Error
}

export class SshConnectionWorkAdmissionClosedError extends Error {
  constructor() {
    super('ssh_connection_work_admission_closed')
    this.name = 'SshConnectionWorkAdmissionClosedError'
  }
}

/** Tracks local operation/channel lifetime; channel closure is not remote process-exit proof. */
export class SshConnectionWorkLedger {
  private readonly pending = new Set<WorkEntry>()
  private readonly scope = new AsyncLocalStorage<WorkEntry>()
  private fenced = false
  private exempt: WorkEntry | undefined
  private failure: Error | undefined
  private readonly failureWake = Promise.withResolvers<Error>()

  constructor(
    private readonly onChange: () => void = () => {},
    private readonly assertAdmission: () => void = () => {}
  ) {}

  isDrained(): boolean {
    return this.pending.size === 0 && !this.failure
  }

  private recordFailure(error: Error): void {
    this.failure ??= error
    this.failureWake.resolve(this.failure)
  }

  markTransportUnverifiable(): void {
    if (this.fenced) {
      this.recordFailure(new Error('ssh_connection_reset_transport_unverifiable'))
    }
  }

  private admit(): WorkEntry {
    this.assertAdmission()
    assertProfileLifetimeAdmission()
    const parent = this.scope.getStore()
    if (this.fenced && (!parent || !this.pending.has(parent) || parent === this.exempt)) {
      throw new SshConnectionWorkAdmissionClosedError()
    }
    const completion = Promise.withResolvers<void>()
    const entry: WorkEntry = { done: completion.promise, finish: completion.resolve }
    this.pending.add(entry)
    return entry
  }

  private settle(entry: WorkEntry, error?: unknown): void {
    if (!this.pending.delete(entry)) {
      return
    }
    if (error !== undefined) {
      entry.failure = error instanceof Error ? error : new Error(String(error))
    }
    if (this.fenced && entry !== this.exempt && entry.failure) {
      this.recordFailure(entry.failure)
    }
    entry.finish()
    this.onChange()
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const entry = this.admit()
    return this.scope.run(entry, async () => {
      try {
        const result = await operation()
        this.settle(entry)
        return result
      } catch (error) {
        this.settle(entry, error)
        throw error
      }
    })
  }

  beginSession() {
    const entry = this.admit()
    let closed = false
    let closeFailed = false
    let active = 0
    const finish = () => {
      if (closed && !closeFailed && active === 0) {
        this.settle(entry)
      }
    }
    return {
      run: async <T>(operation: () => Promise<T>): Promise<T> => {
        if (closed) {
          throw new Error('ssh_connection_work_session_closed')
        }
        active++
        try {
          return await this.scope.run(entry, () => this.run(operation))
        } catch (error) {
          entry.failure ??= error instanceof Error ? error : new Error(String(error))
          if (this.fenced) {
            this.recordFailure(entry.failure)
          }
          throw error
        } finally {
          active--
          finish()
        }
      },
      close: (error?: unknown) => {
        closed = true
        if (error !== undefined) {
          // Failed closure must remain observable even if reset has not started yet.
          closeFailed = true
          entry.failure ??= error instanceof Error ? error : new Error(String(error))
          if (this.fenced) {
            this.recordFailure(entry.failure)
          }
        }
        finish()
      }
    }
  }

  beginChannelOpen() {
    const entry = this.admit()
    let bound = false
    return {
      bind: (resource: object) => {
        if (bound || !this.pending.has(entry)) {
          throw new Error('ssh_connection_work_channel_binding_changed')
        }
        entry.resource = resource
        bound = true
      },
      markUnverifiable: (error: Error) => {
        if (this.pending.has(entry)) {
          entry.failure ??= error
          if (this.fenced && entry !== this.exempt) {
            this.recordFailure(error)
          }
        }
      },
      close: (error?: unknown) => this.settle(entry, error)
    }
  }

  fenceForReset(controlChannel?: object) {
    if (this.fenced) {
      throw new Error('ssh_connection_work_already_fenced')
    }
    const matches = controlChannel
      ? [...this.pending].filter((entry) => entry.resource === controlChannel)
      : []
    if (controlChannel && matches.length !== 1) {
      throw new Error('ssh_connection_work_control_channel_unproven')
    }
    this.exempt = matches[0]
    this.fenced = true
    const assertDrained = () => {
      if (this.failure) {
        throw this.failure
      }
      if ([...this.pending].some((entry) => entry !== this.exempt)) {
        throw new Error('ssh_connection_work_not_drained')
      }
    }
    return {
      drain: async (signal: AbortSignal) => {
        signal.throwIfAborted()
        for (;;) {
          if (this.failure) {
            throw this.failure
          }
          const pending = [...this.pending].filter((entry) => entry !== this.exempt)
          for (const entry of pending) {
            if (entry.failure) {
              throw entry.failure
            }
          }
          if (pending.length === 0) {
            assertDrained()
            return
          }
          await waitForPromiseWithSignal(
            Promise.race([
              Promise.all(pending.map((entry) => entry.done)),
              this.failureWake.promise.then((error) => {
                throw error
              })
            ]),
            signal
          )
        }
      },
      assertDrained
    }
  }
}
