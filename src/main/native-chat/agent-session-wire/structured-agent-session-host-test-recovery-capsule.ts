// The host harness's recovery capsule. A host a test replaced keeps its restart-offer lane running
// (a withdrawal is fire-and-forget), and nothing else waits for it, so cleanup waits here before it
// removes the directory whose lock that operation holds.

import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'

type Capsule = AgentSessionRecoveryCapsule

export class TrackedTestRecoveryCapsule extends AgentSessionRecoveryCapsule {
  private readonly running = new Set<Promise<unknown>>()

  /** Until no operation runs, including one a finished operation's lane starts next. */
  async settled(): Promise<void> {
    do {
      await Promise.allSettled(this.running)
      await new Promise((resolve) => setImmediate(resolve))
    } while (this.running.size > 0)
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
    operation.then(forget, forget)
    return operation
  }
}
