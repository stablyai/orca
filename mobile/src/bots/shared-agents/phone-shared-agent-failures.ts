// What a page's call to a shared agent answers when the phone can't take it to the host live.
import { SHARED_BOT_HOST_ERRORS } from '../../../../src/shared/bots/shared-bot-hosts'
import type { RpcFailure } from '../../../../src/shared/remote-runtime/rpc/rpc-response-shape'
import { sharedBotHeldRefusal } from '../../../../src/shared/bots/shared-bot-held-routing'
import type { HoldResult } from './phone-shared-agent-held'
import type { PhoneSharedAgent } from './phone-shared-agent-store'

const failure = (method: string, code: string, message: string): RpcFailure => ({
  id: method,
  ok: false,
  error: { code, message }
})

export function sharedAgentOffline(entry: PhoneSharedAgent, method: string): RpcFailure {
  return failure(method, SHARED_BOT_HOST_ERRORS.offline, `${entry.ownerName}’s computer is offline`)
}

/** A send the phone tried to hold: why it isn't sent now, including when it waits. */
export function heldSendFailure(entry: PhoneSharedAgent, result: HoldResult): RpcFailure {
  const refusal = sharedBotHeldRefusal(result, entry.ownerName)
  return refusal
    ? failure('agentSession.send', ...refusal)
    : sharedAgentOffline(entry, 'agentSession.send')
}
