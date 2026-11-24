/** A kept agent that may still run must never get a second writer beside it. */
export class KeptProviderRelayUnreachableError extends Error {
  constructor(readonly chatKey: string) {
    super('agent_kept_running_unreachable')
    this.name = 'KeptProviderRelayUnreachableError'
  }
}

/** The kept agent was proven gone during a launch reattach; the rebind ends instead of starting anew. */
export class KeptProviderRelayEndedError extends Error {
  constructor(readonly chatKey: string) {
    super('agent_kept_running_ended')
    this.name = 'KeptProviderRelayEndedError'
  }
}
