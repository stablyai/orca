import type { AccountBoundLinks } from '../orca-profiles/orca-account-service'
import type { BotController } from './bot-controller'
import { botLinkOwners } from '../../shared/bot-link-owners'

/** D5: a bot's Slack, Linear and GitHub links belong to the account that made them, so no other
 * account may become the host's account while they exist. Sign-out stays allowed. */
export function botAccountSwitchBlocker(args: {
  bots: () => Pick<BotController, 'list'> | null
  /** The profile whose bots `bots` lists. */
  profileId: () => string | null
}): AccountBoundLinks {
  return {
    profileId: args.profileId,
    refusal: (nextUserId, profileUserId) => {
      const blocked = (args.bots()?.list() ?? []).filter((bot) =>
        botLinkOwners(bot).some((owner) => (owner ?? profileUserId) !== nextUserId)
      )
      if (blocked.length === 0) {
        return null
      }
      const names = blocked.map((bot) => bot.name).join(', ')
      return `Remove these bots' connectors or move the bots first: ${names}.`
    },
    holders: (profileUserId) => {
      const linked = (args.bots()?.list() ?? []).flatMap((bot) => {
        const owners = botLinkOwners(bot).flatMap((owner) => owner ?? profileUserId ?? [])
        return owners.length > 0 ? [{ name: bot.name, owners }] : []
      })
      return {
        ownerUserIds: [...new Set(linked.flatMap((bot) => bot.owners))],
        botNames: linked.map((bot) => bot.name)
      }
    }
  }
}
