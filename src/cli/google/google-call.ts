// How every `orca gmail|calendar|contacts|drive|docs|sheets` command calls the host: as the chat it
// runs from and the account named, and never with a request too large for a paired server.
import { readInjectedAgentSessionId } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { PAIRED_REQUEST_PARAMS_MAX_BYTES } from '../../shared/remote-runtime/paired-request-budget'
import type { HandlerContext } from '../dispatch/dispatch'
import { getOptionalStringFlag } from '../arguments/flags'
import { RuntimeClientError } from '../runtime/connection/types'

/** The chat it runs from and the account named; every Google command sends both. */
export function googleCallParams(flags: HandlerContext['flags']) {
  const callerSessionId = readInjectedAgentSessionId()
  const account = getOptionalStringFlag(flags, 'account')
  return { ...(callerSessionId ? { callerSessionId } : {}), ...(account ? { account } : {}) }
}

export async function callGoogle<T>(
  client: HandlerContext['client'],
  method: string,
  params: Record<string, unknown>
) {
  const size = Buffer.byteLength(JSON.stringify(params))
  if (size > PAIRED_REQUEST_PARAMS_MAX_BYTES) {
    throw new RuntimeClientError(
      'invalid_argument',
      `That is ${Math.ceil(size / 1024)} KB to send; Orca sends up to ${Math.floor(PAIRED_REQUEST_PARAMS_MAX_BYTES / 1024)} KB at once. Split it into smaller parts.`
    )
  }
  return client.call<T>(method, params)
}
