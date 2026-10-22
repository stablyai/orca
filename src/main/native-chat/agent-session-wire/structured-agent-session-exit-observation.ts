export class StructuredAgentSessionExitObservation {
  heldSends?: ReadonlySet<string>
  observedAt?: number

  record = (heldSends?: ReadonlySet<string>, observedAt?: number): void => {
    this.heldSends ??= heldSends && new Set(heldSends)
    this.observedAt ??= observedAt
  }
}
