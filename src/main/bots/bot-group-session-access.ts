import { isBotGroupMemberSession } from '../../shared/bots/bot-group'
import type { RpcCallerIdentity } from '../runtime/rpc/callers/rpc-caller-identity'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { InvalidArgumentError } from '../runtime/rpc/core'
import { runtimeBotGroups } from './bot-group-runtime'

export function assertBotGroupSessionAccess(
  runtime: OrcaRuntimeService,
  sessionId: string,
  caller: RpcCallerIdentity | undefined,
  readOnly = false
): void {
  if (!isBotGroupMemberSession(sessionId)) {
    return
  }
  if (caller?.kind !== 'desktop' && caller?.kind !== 'paired-device') {
    throw new Error(
      'Only a human can operate a group bot session. Use explicit bot questions and handoffs for peer work.'
    )
  }
  if (readOnly) {
    return
  }
  if (!runtimeBotGroups(runtime).store.memberOf(sessionId)) {
    throw new Error('This bot is no longer a member of the group.')
  }
}

export const BOT_GROUP_ROOM_CARD_REFUSAL =
  "This card can't show in a group room, so none was shown. Ask your owner to request this in your Home chat."

/** A room draws only its members' turns, so a card written into a member's session would never show. */
export function refuseBotGroupRoomCard(sessionId: string): void {
  if (isBotGroupMemberSession(sessionId)) {
    throw new InvalidArgumentError(BOT_GROUP_ROOM_CARD_REFUSAL)
  }
}
