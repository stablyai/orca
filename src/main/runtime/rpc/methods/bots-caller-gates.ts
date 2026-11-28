// Which bot changes an agent's CLI may not make; the owner's Orca and phone make them all.
import { InvalidArgumentError, type RpcContext } from '../core'
import { isAgentRpcCaller } from '../callers/rpc-caller-identity'
import { isCliBotCreateAllowed } from '../../../bots/bot-cli-create'
import type { BotItemOwnerActor } from '../../../bots/bot-items-input'

/** Buttons in the owner's Orca; an agent's CLI never presses them. */
export function ownerOnly(context: Pick<RpcContext, 'caller'>, refusal: string): void {
  if (isAgentRpcCaller(context.caller)) {
    throw new InvalidArgumentError(refusal)
  }
}

/** `bots.create`'s gate: the owner's Orca and phone, or — when enabled via `orca serve --allow-cli-bot-create`
 *  or desktop Settings › Bots — this machine's own CLI creating a plain or template bot. A paired CLI never,
 *  and never from a card or a share link, which stay the owner's to accept. */
export function botCreateCaller(
  context: Pick<RpcContext, 'caller'>,
  params: { fromOffer?: unknown; fromShare?: unknown },
  cliCreateAllowed: boolean = isCliBotCreateAllowed()
): void {
  if (
    cliCreateAllowed &&
    context.caller?.kind === 'local-cli' &&
    !params.fromOffer &&
    !params.fromShare
  ) {
    return
  }
  ownerOnly(
    context,
    'A bot can’t create a bot. Propose one with `orca bot create --offer`; your owner creates it from the card.'
  )
}

export function botItemOwnerActor(context: RpcContext): BotItemOwnerActor {
  ownerOnly(context, 'Only your owner changes items this way, in Orca.')
  context.runtime.bots.assertEnabled()
  return context.pairedDeviceId
    ? { kind: 'owner', device: context.pairedDeviceId }
    : { kind: 'owner' }
}
