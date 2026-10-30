import type { RuntimeTerminalWait } from '../../../../shared/runtime-terminal-contracts'
import type { TerminalWaiter } from '../../runtime-terminal-contracts'

/** Waits keyed by the terminal they follow; the handle they were asked through only labels the result. */
export class RuntimeTerminalWaiterRegistry {
  private readonly byPtyId = new Map<string, Set<TerminalWaiter>>()

  has(waiter: TerminalWaiter): boolean {
    return this.byPtyId.get(waiter.ptyId)?.has(waiter) ?? false
  }

  forPty(ptyId: string): TerminalWaiter[] {
    return [...(this.byPtyId.get(ptyId) ?? [])]
  }

  add(waiter: TerminalWaiter): void {
    const waiters = this.byPtyId.get(waiter.ptyId) ?? new Set<TerminalWaiter>()
    waiters.add(waiter)
    this.byPtyId.set(waiter.ptyId, waiters)
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

  reject(waiter: TerminalWaiter, code: string): void {
    this.remove(waiter)
    waiter.reject(new Error(code))
  }

  rejectPty(ptyId: string, code: string): void {
    for (const waiter of this.forPty(ptyId)) {
      this.reject(waiter, code)
    }
  }

  rejectAll(code: string): void {
    for (const ptyId of this.byPtyId.keys()) {
      this.rejectPty(ptyId, code)
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
    const waiters = this.byPtyId.get(waiter.ptyId)
    if (!waiters) {
      return
    }
    waiters.delete(waiter)
    if (waiters.size === 0) {
      this.byPtyId.delete(waiter.ptyId)
    }
  }
}
