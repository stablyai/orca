import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'

// Drain replaced hosts’ fire-and-forget withdrawals before removing their lock directories.

type Capsule = AgentSessionRecoveryCapsule

export class TrackedTestRecoveryCapsule extends AgentSessionRecoveryCapsule {
  private readonly running = new Set<Promise<unknown>>()

  private readonly inspections = new Set<Map<Promise<unknown>, unknown>>()

  /** Include follow-up operations queued by finishing work. */
  async settled(options: { inspect?: true } = {}): Promise<void> {
    const failures = new Map<Promise<unknown>, unknown>()
    if (options.inspect) {
      this.inspections.add(failures)
    }
    try {
      do {
        const operations = [...this.running]
        const results = await Promise.allSettled(operations)
        if (options.inspect) {
          results.forEach((result, index) => {
            if (result.status === 'rejected') {
              failures.set(operations[index]!, result.reason)
            }
          })
        }
        await new Promise((resolve) => setImmediate(resolve))
      } while (this.running.size > 0)
    } finally {
      this.inspections.delete(failures)
    }
    if (failures.size > 0) {
      throw new AggregateError([...failures.values()], 'owned recovery operations failed')
    }
  }

  override list(...args: Parameters<Capsule['list']>) {
    return this.track(super.list(...args))
  }

  override listFailed(...args: Parameters<Capsule['listFailed']>) {
    return this.track(super.listFailed(...args))
  }

  override record(...args: Parameters<Capsule['record']>) {
    return this.track(super.record(...args))
  }

  override beginResume(...args: Parameters<Capsule['beginResume']>) {
    return this.track(super.beginResume(...args))
  }

  override completeResume(...args: Parameters<Capsule['completeResume']>) {
    return this.track(super.completeResume(...args))
  }

  override failResume(...args: Parameters<Capsule['failResume']>) {
    return this.track(super.failResume(...args))
  }

  override dismiss(...args: Parameters<Capsule['dismiss']>) {
    return this.track(super.dismiss(...args))
  }

  override forgetSuperseded(...args: Parameters<Capsule['forgetSuperseded']>) {
    return this.track(super.forgetSuperseded(...args))
  }

  override rollbackResume(...args: Parameters<Capsule['rollbackResume']>) {
    return this.track(super.rollbackResume(...args))
  }

  override clearAll(...args: Parameters<Capsule['clearAll']>) {
    return this.track(super.clearAll(...args))
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.running.add(operation)
    const forget = () => this.running.delete(operation)
    operation.then(forget, (error) => {
      for (const inspection of this.inspections) {
        inspection.set(operation, error)
      }
      forget()
    })
    return operation
  }
}
