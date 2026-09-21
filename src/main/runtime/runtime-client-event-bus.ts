import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import { notifyRuntimeListeners } from './runtime-async-boundaries'

type RuntimeClientEventBusDeps = {
  makeTitleGateKey: (rawTitle: string, normalizedTitle: string) => string
  onConsumerAvailabilityChanged: () => void
}

export class RuntimeClientEventBus {
  private readonly listeners = new Set<(event: RuntimeClientEvent) => void>()
  private readonly excludedTerminalSideEffectListeners = new Set<
    (event: RuntimeClientEvent) => void
  >()
  private readonly titleGateKeysByListener = new Map<
    (event: RuntimeClientEvent) => void,
    Map<string, string>
  >()

  constructor(private readonly deps: RuntimeClientEventBusDeps) {}

  on(
    listener: (event: RuntimeClientEvent) => void,
    options?: { consumesTerminalSideEffects?: boolean }
  ): () => void {
    this.listeners.add(listener)
    if (options?.consumesTerminalSideEffects === false) {
      this.excludedTerminalSideEffectListeners.add(listener)
    } else {
      this.titleGateKeysByListener.set(listener, new Map())
    }
    this.deps.onConsumerAvailabilityChanged()
    return () => {
      this.listeners.delete(listener)
      this.excludedTerminalSideEffectListeners.delete(listener)
      this.titleGateKeysByListener.delete(listener)
      this.deps.onConsumerAvailabilityChanged()
    }
  }

  countTerminalSideEffectConsumers(): number {
    return this.listeners.size - this.excludedTerminalSideEffectListeners.size
  }

  emit(event: RuntimeClientEvent): void {
    notifyRuntimeListeners(
      this.listeners,
      (listener) => {
        if (event.type !== 'terminalSideEffects') {
          listener(event)
          return
        }
        const filtered = this.filterTerminalSideEffects(listener, event)
        if (filtered) {
          listener(filtered)
        }
      },
      'client-event'
    )
  }

  clearPtyTitleGate(ptyId: string): void {
    for (const titleGateKeys of this.titleGateKeysByListener.values()) {
      titleGateKeys.delete(ptyId)
    }
  }

  private filterTerminalSideEffects(
    listener: (event: RuntimeClientEvent) => void,
    event: Extract<RuntimeClientEvent, { type: 'terminalSideEffects' }>
  ): Extract<RuntimeClientEvent, { type: 'terminalSideEffects' }> | null {
    const titleGateKeys = this.titleGateKeysByListener.get(listener)
    if (!titleGateKeys) {
      return null
    }
    const facts = event.batch.facts.filter((fact) => {
      if (fact.kind !== 'title') {
        return true
      }
      const gateKey = this.deps.makeTitleGateKey(fact.rawTitle, fact.normalizedTitle)
      if (titleGateKeys.get(event.batch.ptyId) === gateKey) {
        return false
      }
      titleGateKeys.set(event.batch.ptyId, gateKey)
      return true
    })
    if (facts.length === 0) {
      return null
    }
    return facts.length === event.batch.facts.length
      ? event
      : { ...event, batch: { ...event.batch, facts } }
  }
}
