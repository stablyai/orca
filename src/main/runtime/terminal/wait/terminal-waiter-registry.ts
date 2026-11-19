import type { RuntimeTerminalWait } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import type { TerminalWaiter } from './terminal-waiter'

/** Waits keyed by the terminal they follow; the handle they were asked through only labels the result. */
export class RuntimeTerminalWaiterRegistry {
  private readonly byPtyId = new Map<string, Set<TerminalWaiter>>()
  /** Waits moved to another terminal (an Agent-slept agent's woken process) keep their own record. */
  private readonly movedTo = new WeakMap<TerminalWaiter, string>()

  private ptyOf(waiter: TerminalWaiter): string {
    return this.movedTo.get(waiter) ?? waiter.ptyId
  }

  has(waiter: TerminalWaiter): boolean {
    return this.byPtyId.get(this.ptyOf(waiter))?.has(waiter) ?? false
  }

  forPty(ptyId: string): TerminalWaiter[] {
    return [...(this.byPtyId.get(ptyId) ?? [])]
  }

  add(waiter: TerminalWaiter): void {
    const ptyId = this.ptyOf(waiter)
    const waiters = this.byPtyId.get(ptyId) ?? new Set<TerminalWaiter>()
    waiters.add(waiter)
    this.byPtyId.set(ptyId, waiters)
  }

  /** Re-files a wait under another terminal, keeping its deadline and abort. */
  move(waiter: TerminalWaiter, ptyId: string): void {
    this.unindex(waiter)
    this.movedTo.set(waiter, ptyId)
    this.add(waiter)
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

  /** Graph retirement: handle-named waits end with the handles; input custody follows its process instead. */
  rejectRendererBound(code: string): void {
    for (const ptyId of Array.from(this.byPtyId.keys())) {
      for (const waiter of this.forPty(ptyId)) {
        if (!waiter.outlivesRenderer) {
          this.reject(waiter, code)
        }
      }
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
    this.unindex(waiter)
  }

  private unindex(waiter: TerminalWaiter): void {
    const ptyId = this.ptyOf(waiter)
    const waiters = this.byPtyId.get(ptyId)
    if (!waiters) {
      return
    }
    waiters.delete(waiter)
    if (waiters.size === 0) {
      this.byPtyId.delete(ptyId)
    }
  }
}
