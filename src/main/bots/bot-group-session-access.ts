import { isBotGroupMemberSession } from '../../shared/bots/bot-group'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { InvalidArgumentError } from '../runtime/rpc/core'
import { runtimeBotGroups } from './bot-group-runtime'

/** Any caller, a person or an agent, may operate a group member session while it is still a member. */
export function assertBotGroupSessionAccess(runtime: OrcaRuntimeService, sessionId: string): void {
  if (isBotGroupMemberSession(sessionId) && !runtimeBotGroups(runtime).store.memberOf(sessionId)) {
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
