import type { RpcClient } from './rpc-client'

type SubscriptionRecord = {
  method: string
  params: unknown
  listener: (result: unknown) => void
  options?: Parameters<RpcClient['subscribe']>[3]
  disposePhysical: (() => void) | null
  cancelled: boolean
}

export type LogicalSubscriptionRegistryContext = {
  isClosed: () => boolean
  isSuspended: () => boolean
  activeSession: () => RpcClient
  generation: () => number
}

/**
 * The logical subscriptions of a stable client: each record outlives the physical
 * session it is currently attached to, and survives suspend and migration by
 * re-attaching rather than by asking the caller to resubscribe.
 */
export class LogicalSubscriptionRegistry {
  private readonly records = new Map<number, SubscriptionRecord>()
  private nextId = 0

  constructor(private readonly context: LogicalSubscriptionRegistryContext) {}

  add(
    method: string,
    params: unknown,
    listener: (result: unknown) => void,
    options?: Parameters<RpcClient['subscribe']>[3]
  ): () => void {
    const id = ++this.nextId
    const record: SubscriptionRecord = {
      method,
      params,
      listener,
      options,
      disposePhysical: null,
      cancelled: false
    }
    this.records.set(id, record)
    if (!this.context.isSuspended()) {
      this.attach(record, this.context.activeSession(), this.context.generation())
    }
    return () => {
      if (record.cancelled) {
        return
      }
      record.cancelled = true
      record.disposePhysical?.()
      record.disposePhysical = null
      this.records.delete(id)
    }
  }

  updateTerminalViewport(terminal: string, viewport: { cols: number; rows: number }): void {
    for (const record of this.records.values()) {
      if (
        record.params &&
        typeof record.params === 'object' &&
        'terminal' in record.params &&
        record.params.terminal === terminal
      ) {
        record.params = { ...record.params, viewport }
      }
    }
    if (!this.context.isSuspended()) {
      this.context.activeSession().updateTerminalSubscriptionViewport(terminal, viewport)
    }
  }

  // Why: attach before disposing the previous physical subscription so no gap opens,
  // while callbacks stay fenced until the caller makes nextGeneration current.
  replayOnto(nextSession: RpcClient, nextGeneration: number): void {
    for (const record of this.records.values()) {
      const disposePrevious = record.disposePhysical
      this.attach(record, nextSession, nextGeneration)
      disposePrevious?.()
    }
  }

  /** Detach from the physical session but keep the records for a later replay. */
  detachAll(): void {
    for (const record of this.records.values()) {
      record.disposePhysical?.()
      record.disposePhysical = null
    }
  }

  disposeAll(): void {
    for (const record of this.records.values()) {
      record.disposePhysical?.()
    }
    this.records.clear()
  }

  private attach(
    record: SubscriptionRecord,
    session: RpcClient,
    subscriptionGeneration: number
  ): void {
    record.disposePhysical = session.subscribe(
      record.method,
      record.params,
      (result) => {
        if (
          !this.context.isClosed() &&
          !record.cancelled &&
          this.context.generation() === subscriptionGeneration
        ) {
          record.listener(result)
        }
      },
      record.options
    )
  }
}
