// D12: who may ask a bot, and so who may start its owner's automations: the bot's owner, and the
// members they added with the same rights. The one rule every source and the cloud apply.
export type BotAskers = { ownerUserId: string; members: readonly string[] }

export function canAskBot(bot: BotAskers, userId: string): boolean {
  return userId === bot.ownerUserId || bot.members.includes(userId)
}
