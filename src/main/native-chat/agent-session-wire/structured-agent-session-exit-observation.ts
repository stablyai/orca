import type { StructuredAgentSessionEndedEvent } from './structured-agent-session-adapter'

export class StructuredAgentSessionExitObservation {
  heldSends?: ReadonlySet<string>
  observedAt?: number
  close?: Pick<StructuredAgentSessionEndedEvent, 'processExit' | 'deathEvidenceKind'>

  record = (
    heldSends?: ReadonlySet<string>,
    observedAt?: number,
    close?: StructuredAgentSessionExitObservation['close']
  ): void => {
    this.heldSends ??= heldSends && new Set(heldSends)
    this.observedAt ??= observedAt
    this.close ??= close
  }
}

/** The first spontaneous root exit the adapter observed for this sink's acquisition, taken where
 *  the adapter sees it, before output drain, cleanup or host serialization can delay it. The
 *  listener's own clock times it, so adapter and host clocks never mix. */
export class StructuredAgentSessionRootExitReceipt {
  observed = false
  private readonly listeners = new Set<() => void>()

  observe = (): void => {
    if (this.observed) {
      return
    }
    this.observed = true
    const listeners = [...this.listeners]
    this.listeners.clear()
    for (const listener of listeners) {
      listener()
    }
  }

  /** Replays an exit already observed; the returned call stops listening. */
  listen = (listener: () => void): (() => void) => {
    if (this.observed) {
      listener()
      return () => {}
    }
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
