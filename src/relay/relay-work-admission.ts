import type { RequestContext } from './dispatcher-contract'
import { allowsRelayWorkDuringDrain } from '../shared/relay-work-drain-contract'

/** Handler drain is not proof of physical process exit or detached producer cleanup. */
export class RelayWorkAdmission {
  private draining = false
  private readonly active = new Map<object, { context: RequestContext; done: Promise<void> }>()

  allows(method: string, notification = false): boolean {
    return !this.draining || allowsRelayWorkDuringDrain(method, notification)
  }

  async run<T>(
    method: string,
    context: RequestContext,
    operation: () => T | Promise<T>
  ): Promise<T> {
    if (!this.allows(method)) {
      throw new Error('relay_work_admission_closed')
    }
    return this.track(context, operation)
  }

  runNotification(method: string, context: RequestContext, operation: () => void): void {
    if (!this.allows(method, true)) {
      return
    }
    const key = {}
    const completion = Promise.withResolvers<void>()
    this.active.set(key, { context, done: completion.promise })
    const finish = () => {
      this.active.delete(key)
      completion.resolve()
    }
    try {
      const result = operation()
      void Promise.resolve(result).then(finish, (error) => {
        finish()
        process.stderr.write(`[relay] Notification handler failed: ${String(error)}\n`)
      })
    } catch (error) {
      finish()
      throw error
    }
  }

  assertActiveContext(context: RequestContext): void {
    if (![...this.active.values()].some((entry) => entry.context === context)) {
      throw new Error('relay_work_drain_context_not_active')
    }
  }

  /** Only the actual initiating request context may be excluded from its own drain. */
  async beginDrain(exclude?: RequestContext): Promise<void> {
    if (exclude) {
      this.assertActiveContext(exclude)
    }
    this.draining = true
    for (;;) {
      const pending = [...this.active.values()].filter((entry) => entry.context !== exclude)
      if (pending.length === 0) {
        return
      }
      await Promise.all(pending.map((entry) => entry.done))
    }
  }

  private async track<T>(context: RequestContext, operation: () => T | Promise<T>): Promise<T> {
    const key = {}
    const completion = Promise.withResolvers<void>()
    this.active.set(key, { context, done: completion.promise })
    try {
      return await operation()
    } finally {
      this.active.delete(key)
      completion.resolve()
    }
  }
}
