// D12: who may ask a bot, and so who may start its owner's automations: the bot's owner, the
// members they added with the same rights, and anyone signed in to an Orca account the owner shared
// the bot with. The one rule every source and the cloud apply.
export type BotAskers = {
  ownerUserId: string
  members: readonly string[]
  // The Orca accounts in the bot's sharedWith.
  sharedAccountIds?: readonly string[]
}

/** linkedAccountIds: the Orca accounts linked to userId, any of which may carry a share. The
 *  connector's own wrapper requires them, so no caller there forgets a share. */
export function canAskBot(
  bot: BotAskers,
  userId: string,
  linkedAccountIds: readonly string[] = []
): boolean {
  return (
    userId === bot.ownerUserId ||
    bot.members.includes(userId) ||
    linkedAccountIds.some((accountId) => bot.sharedAccountIds?.includes(accountId) === true)
  )
}
