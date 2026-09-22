import type { RuntimeTerminalWait } from '../../shared/runtime-types'
import type { TerminalWaiter } from './runtime-terminal-contracts'

export class RuntimeTerminalWaiterRegistry {
  private readonly byHandle = new Map<string, Set<TerminalWaiter>>()

  get(handle: string): ReadonlySet<TerminalWaiter> | undefined {
    return this.byHandle.get(handle)
  }

  handles(): Iterable<string> {
    return this.byHandle.keys()
  }

  add(waiter: TerminalWaiter): void {
    const waiters = this.byHandle.get(waiter.handle) ?? new Set<TerminalWaiter>()
    waiters.add(waiter)
    this.byHandle.set(waiter.handle, waiters)
  }

  resolve(waiter: TerminalWaiter, result: RuntimeTerminalWait): void {
    this.remove(waiter)
    waiter.resolve(result)
  }

  bindAbort(waiter: TerminalWaiter, signal: AbortSignal | undefined): boolean {
    if (!signal) {
      return true
    }
    if (signal.aborted) {
      return false
    }
    const onAbort = (): void => {
      this.remove(waiter)
      waiter.reject(new Error('request_aborted'))
    }
    waiter.abortCleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    return true
  }

  rejectHandle(handle: string, code: string): void {
    const waiters = this.byHandle.get(handle)
    if (!waiters) {
      return
    }
    for (const waiter of Array.from(waiters)) {
      this.remove(waiter)
      waiter.reject(new Error(code))
    }
  }

  rejectAll(code: string): void {
    for (const handle of Array.from(this.byHandle.keys())) {
      this.rejectHandle(handle, code)
    }
  }

  remove(waiter: TerminalWaiter): void {
    if (waiter.timeout) {
      clearTimeout(waiter.timeout)
    }
    if (waiter.cancelIdlePoll) {
      waiter.cancelIdlePoll()
    }
    if (waiter.abortCleanup) {
      waiter.abortCleanup()
      waiter.abortCleanup = null
    }
    const waiters = this.byHandle.get(waiter.handle)
    if (!waiters) {
      return
    }
    waiters.delete(waiter)
    if (waiters.size === 0) {
      this.byHandle.delete(waiter.handle)
    }
  }
}
