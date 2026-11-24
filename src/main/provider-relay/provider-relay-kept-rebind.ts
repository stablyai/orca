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

/** Chats being reattached at launch: a proven-gone agent ends the rebind instead of starting anew. */
const rebinding = new Set<string>()

export async function withProviderRelayRebind<T>(chatKey: string, run: () => Promise<T>) {
  rebinding.add(chatKey)
  try {
    return await run()
  } finally {
    rebinding.delete(chatKey)
  }
}

export function providerRelayRebinding(chatKey: string): boolean {
  return rebinding.has(chatKey)
}
