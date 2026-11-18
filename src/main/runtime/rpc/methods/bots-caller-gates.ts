// Which bot changes an agent's CLI may not make; the owner's Orca and phone make them all.
import { InvalidArgumentError, type RpcContext } from '../core'
import { isAgentRpcCaller } from '../callers/rpc-caller-identity'

/** Buttons in the owner's Orca; an agent's CLI never presses them. */
export function ownerOnly(context: RpcContext, refusal: string): void {
  if (isAgentRpcCaller(context.caller)) {
    throw new InvalidArgumentError(refusal)
  }
}
