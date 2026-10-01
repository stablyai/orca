import type { RequestContext } from './dispatcher-contract'
import { allowsRelayWorkDuringDrain } from '../shared/relay-work-drain-contract'

/** Handler drain is not proof of physical process exit or detached producer cleanup. */
export class RelayWorkAdmission {
  private draining = false
  private readonly active = new Map<object, { context: RequestContext; done: Promise<void> }>()

  allows(method: string, notification = false): boolean {
    return !this.draining || allowsRelayWorkDuringDrain(method, notification)
  }

  // Why not async: an async wrapper adds microtask turns to every relay handler's response.
  run<T>(method: string, context: RequestContext, operation: () => T | Promise<T>): Promise<T> {
    if (!this.allows(method)) {
      return Promise.reject(new Error('relay_work_admission_closed'))
    }
    const finish = this.trackEntry(context)
    let result: Promise<T>
    try {
      const value = operation()
      result = value instanceof Promise ? value : Promise.resolve(value)
    } catch (error) {
      finish()
      return Promise.reject(error)
    }
    result.then(finish, finish)
    return result
  }

  runNotification(method: string, context: RequestContext, operation: () => void): void {
    if (!this.allows(method, true)) {
      return
    }
    const finish = this.trackEntry(context)
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

  // Why: no Promise.withResolvers — the legacy relay bundle still targets Node 18 hosts.
  private trackEntry(context: RequestContext): () => void {
    const key = {}
    let resolve!: () => void
    const done = new Promise<void>((settle) => {
      resolve = settle
    })
    this.active.set(key, { context, done })
    return () => {
      this.active.delete(key)
      resolve()
    }
  }
}
