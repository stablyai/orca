// A call to a shared agent's host while held sends are on: a message to a host that is away is held
// in Orca Cloud, and a new chat started meanwhile is a placeholder until its first message starts it.
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { RpcResponse } from '../../../shared/remote-runtime/rpc/rpc-response-shape'
import { sharedBotAnswer, sharedBotOffline } from './shared-bot-host-answers'
import { namesSharedBotNewChat, type SharedBotHeldSends } from './shared-bot-held-sends'
import type { SharedBotLink } from './shared-bot-pairing'
import type { SharedBotHostEntry } from './shared-bot-host-store'

export async function callHoldingHost(
  held: SharedBotHeldSends,
  entry: SharedBotHostEntry,
  link: SharedBotLink,
  method: string,
  params: unknown,
  send: (method: string, params: unknown) => Promise<RpcResponse>
): Promise<RuntimeRpcResponse<unknown>> {
  if (method === 'agentSession.send') {
    const handedOff = await held.send(entry, link, params)
    if (handedOff) {
      return handedOff
    }
  }
  const local = held.answerHere(entry, link, method, params)
  if (local) {
    return local
  }
  // The host doesn't know a placeholder chat yet; nothing of it can be read there.
  if (link !== 'live' || namesSharedBotNewChat(params)) {
    return sharedBotOffline(entry, method)
  }
  try {
    const response =
      method === 'agentSession.send'
        ? await held.sendWithKept(params, send)
        : await send(method, params)
    held.noteAnswer(entry, method, params, response)
    return sharedBotAnswer(entry, response)
  } catch {
    // The link closed or timed out under the request: an answer the window can read.
    return sharedBotOffline(entry, method)
  }
}
