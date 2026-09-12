type Waiter = { pending: Set<object>; finish: (error?: unknown) => void }

/** Observes a fixed set of operations; never host application or process-liveness proof. */
export class SshMultiplexerSettlementBarrier {
  private readonly pending = new Set<object>()
  private readonly waiters = new Set<Waiter>()
  private retainFailures = false
  private failure: Error | undefined

  retainFailureEvidence(): void {
    this.retainFailures = true
  }

  assertSettled(exclude?: object): void {
    if (this.failure) {
      throw this.failure
    }
    if (exclude && !this.pending.has(exclude)) {
      throw new Error('ssh_mux_settlement_exemption_unproven')
    }
    if ([...this.pending].some((entry) => entry !== exclude)) {
      throw new Error('ssh_mux_settlement_pending')
    }
  }

  retain(entry: object): void {
    this.pending.add(entry)
  }

  settle(entry: object, result: { ok: true } | { ok: false; error: Error }): void {
    if (!this.pending.delete(entry)) {
      return
    }
    if (this.retainFailures && !result.ok) {
      this.failure ??= result.error
    }
    for (const waiter of this.waiters) {
      if (!waiter.pending.delete(entry)) {
        continue
      }
      if (!result.ok) {
        waiter.finish(result.error)
      } else if (waiter.pending.size === 0) {
        waiter.finish()
      }
    }
  }

  async wait(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const pending = new Set(this.pending)
    if (pending.size === 0) {
      return
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => waiter.finish(signal.reason)
      const waiter: Waiter = {
        pending,
        finish: (error) => {
          this.waiters.delete(waiter)
          signal.removeEventListener('abort', onAbort)
          pending.clear()
          if (error !== undefined) {
            reject(error)
          } else {
            resolve()
          }
        }
      }
      this.waiters.add(waiter)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
}
