import { readInjectedAgentSessionId } from '../../shared/agent-session-caller-env'
import type {
  CliStatusCaller,
  OrchestrationCallerShowResult
} from '../../shared/orchestration-caller-status'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES } from '../../shared/orchestration-session-caller-codes'
import type { RuntimeClient } from './client'
import { RuntimeClientError } from './types'

const SESSION_REFUSAL_CODES = new Set<string>(
  Object.values(ORCHESTRATION_SESSION_CALLER_ERROR_CODES)
)

// Resolving a session may bring up the agent-session host, which the 1s status probe cannot cover.
const CALLER_SHOW_TIMEOUT_MS = 10_000

/**
 * This process's Orca session ID, resolved by the host from the session id its environment carries.
 * `undefined` when there is none to show: not a session, an older host, or a failed call.
 */
export async function resolveCliStatusCaller(
  client: Pick<RuntimeClient, 'call'>
): Promise<CliStatusCaller | undefined> {
  const sessionId = readInjectedAgentSessionId()
  // Why: terminal agents have no Orca session ID yet, so their status stays exactly as it was.
  if (!sessionId) {
    return undefined
  }
  try {
    const response = await client.call<OrchestrationCallerShowResult>(
      'orchestration.callerShow',
      undefined,
      { timeoutMs: CALLER_SHOW_TIMEOUT_MS }
    )
    return response.result.caller ?? undefined
  } catch (error) {
    if (error instanceof RuntimeClientError && SESSION_REFUSAL_CODES.has(error.code)) {
      return { live: false, refusal: { code: error.code, message: error.message } }
    }
    return undefined
  }
}
