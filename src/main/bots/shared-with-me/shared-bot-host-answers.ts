// What a shared agent's host answers the window, as the window reads it: the host's own answer named
// for the host it asked, or why the host gave none.
import {
  SHARED_BOT_HOST_ERRORS,
  SHARED_BOT_UNSHARED_MESSAGE
} from '../../../shared/bots/shared-bot-hosts'
import { relayStreamError } from '../../../shared/remote-runtime/relay/client/relay-rpc-streams'
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { RpcResponse } from '../../../shared/remote-runtime/rpc/rpc-response-shape'
import type { SharedBotHostEntry } from './shared-bot-host-store'

export const sharedBotFailure = (
  id: string,
  code: string,
  message: string
): RuntimeRpcResponse<unknown> => ({ id, ok: false, error: { code, message } })

/** The host's own answer, named for the host the window asked. */
export function sharedBotAnswer(
  entry: Pick<SharedBotHostEntry, 'environmentId'>,
  response: RpcResponse
): RuntimeRpcResponse<unknown> {
  return response.ok
    ? { ...response, _meta: { runtimeId: response._meta?.runtimeId ?? entry.environmentId } }
    : response
}

/** One event of a subscription on the host's link, as the window reads it. */
export function sharedBotStreamAnswer(
  entry: Pick<SharedBotHostEntry, 'environmentId'>,
  method: string,
  result: unknown
): RuntimeRpcResponse<unknown> {
  const error = relayStreamError(result)
  return error === null
    ? { id: method, ok: true, result, _meta: { runtimeId: entry.environmentId } }
    : sharedBotFailure(method, SHARED_BOT_HOST_ERRORS.offline, error)
}

/** A call the host wasn't reached for, and nothing was held for. */
export function sharedBotOffline(
  entry: SharedBotHostEntry,
  method = 'agentSession.send'
): RuntimeRpcResponse<unknown> {
  return sharedBotFailure(
    method,
    SHARED_BOT_HOST_ERRORS.offline,
    `${entry.ownerName}’s computer is offline`
  )
}

/** A call to a host whose share the owner ended: never offline, and never an unknown host. */
export function sharedBotUnshared(method: string): RuntimeRpcResponse<unknown> {
  return sharedBotFailure(method, SHARED_BOT_HOST_ERRORS.unshared, SHARED_BOT_UNSHARED_MESSAGE)
}
