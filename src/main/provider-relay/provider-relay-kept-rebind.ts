import { providerDiagnostic } from '../../shared/agent-session/failures/agent-session-failure'
const KEPT_UNREACHABLE_START_DETAIL =
  "Orca can't reach this chat's agent, which may still be running, so it won't start a second one. Send again once Orca reconnects to it."

/** A kept agent that may still run must never get a second writer beside it. */
export class KeptProviderRelayUnreachableError extends Error {
  readonly providerDiagnostic = providerDiagnostic(KEPT_UNREACHABLE_START_DETAIL, 'person')

  constructor(readonly chatKey: string) {
    super('agent_kept_running_unreachable')
    this.name = 'KeptProviderRelayUnreachableError'
  }
}

/** Anywhere in a start failure's causes: a refusal beside a possibly running agent proves no exit. */
export function keptProviderRelayUnreachableWithin(error: unknown, depth = 0): boolean {
  if (depth >= 6 || !(error instanceof Error)) {
    return false
  }
  if (error instanceof KeptProviderRelayUnreachableError) {
    return true
  }
  if (error instanceof AggregateError) {
    return error.errors.some((inner) => keptProviderRelayUnreachableWithin(inner, depth + 1))
  }
  return keptProviderRelayUnreachableWithin(error.cause, depth + 1)
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
