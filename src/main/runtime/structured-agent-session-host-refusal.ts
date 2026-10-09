// Why structured chats are refused in this process: its chat journal would not open at install
// (damaged or unavailable). Everything else goes on without a host.

import {
  isAgentSessionRefusalError,
  type AgentSessionRefusalError
} from '../../shared/agent-session-wire-refusals'

let installRefusal: AgentSessionRefusalError | null = null

/** Why structured chats are refused in this process, or null when nothing refuses them. */
export function structuredAgentSessionHostRefusal(): AgentSessionRefusalError | null {
  return installRefusal
}

/** Whether `error` is the refusal structured requests are getting right now. */
function isStructuredAgentSessionHostRefusal(error: unknown): boolean {
  const refusal = installRefusal
  return (
    refusal !== null &&
    isAgentSessionRefusalError(error) &&
    error.refusal.code === refusal.refusal.code &&
    error.refusal.message === refusal.refusal.message
  )
}

/** For work that goes on without chats: the refusal chats are getting leaves this process with no
 *  host, and any other install failure still throws. */
export async function ensureStructuredAgentSessionHostUnlessRefused(
  ensureHost: () => Promise<unknown>
): Promise<void> {
  try {
    await ensureHost()
  } catch (error) {
    if (!isStructuredAgentSessionHostRefusal(error)) {
      throw error
    }
  }
}

/** Set when the journal database would not open; cleared by a later install. The install retries
 *  on the next call, so a refusal that can clear does. */
export function recordStructuredAgentSessionHostInstallRefusal(
  refusal: AgentSessionRefusalError | null
): void {
  installRefusal = refusal
}
