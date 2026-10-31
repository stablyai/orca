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
