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

// Fields `local-cli` may set when direct bot creation is enabled. Owner-only fields such as
// `permissionMode`, `launch`, `fromOffer`, `fromShare`, `takingOver`, and `importFrom` stay off-limits.
const LOCAL_CLI_BOT_CREATE_KEYS = new Set([
  'name',
  'agent',
  'avatar',
  'avatarColor',
  'avatarOutfit',
  'handOff',
  'seed',
  'fromTemplate',
  'templateNameShown'
])

function hasOnlyLocalCliCreateFields(params: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && !LOCAL_CLI_BOT_CREATE_KEYS.has(key)) {
      return false
    }
  }
  return true
}

/** `bots.create`'s gate: the owner's Orca and phone, or — when enabled via `orca serve --allow-cli-bot-create`
 *  or desktop Settings › Bots — this machine's own CLI creating a plain or template bot without owner-only
 *  overrides (such as `permissionMode`, `launch`, `fromOffer`, `fromShare`, `takingOver`, or `importFrom`).
 *  A paired CLI is never allowed. */
export function botCreateCaller(
  context: Pick<RpcContext, 'caller'>,
  params: Record<string, unknown>,
  cliCreateAllowed: boolean = isCliBotCreateAllowed()
): void {
  if (
    cliCreateAllowed &&
    context.caller?.kind === 'local-cli' &&
    hasOnlyLocalCliCreateFields(params)
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
