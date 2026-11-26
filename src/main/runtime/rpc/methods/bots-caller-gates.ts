// Which bot changes an agent's CLI may not make; the owner's Orca and phone make them all.
import { InvalidArgumentError, type RpcContext } from '../core'
import { isAgentRpcCaller } from '../callers/rpc-caller-identity'
import type { BotItemOwnerActor } from '../../../bots/bot-items-input'

/** Buttons in the owner's Orca; an agent's CLI never presses them. */
export function ownerOnly(context: RpcContext, refusal: string): void {
  if (isAgentRpcCaller(context.caller)) {
    throw new InvalidArgumentError(refusal)
  }
}

export function botItemOwnerActor(context: RpcContext): BotItemOwnerActor {
  ownerOnly(context, 'Only your owner changes items this way, in Orca.')
  context.runtime.bots.assertEnabled()
  return context.pairedDeviceId
    ? { kind: 'owner', device: context.pairedDeviceId }
    : { kind: 'owner' }
}
