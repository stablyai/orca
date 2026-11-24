// What the host's share list changes for teammates' access: who is removed loses their devices, and a
// teammate reads the shared bot without the list of whom else it is shared with.
import type { Bot } from '../../../shared/bot-types'
import type { BotShare } from '../../../shared/bots/bot-team-shares'
import type { BotHostUpdates } from '../../../shared/rpc-contract/bots-params'
import type { BotShareCallerScope } from '../../runtime/rpc/callers/rpc-caller-scope'
import type { BotShareOfferMint } from '../bot-team-share-deliveries'

/** The RPC server's teammate devices; null until it starts, and on a host without one. */
export type BotShareDevices = {
  mintBotShareOffer: BotShareOfferMint
  /** One teammate's devices with `accountId`, else every device on the bot; false if not all ended. */
  revokeBotShareDevices: (botId: string, accountId?: string) => Promise<boolean>
}

/** The bots a teammate's share connection lists: the shared bot alone, without its share list. */
export function botShareListedBots(
  bots: readonly Bot[],
  scope: Pick<BotShareCallerScope, 'botId'>
): Omit<Bot, 'shares'>[] {
  return bots.filter((bot) => bot.id === scope.botId).map(({ shares: _others, ...bot }) => bot)
}

/** Takes the share off the list, then ends that account's devices on the bot at once. */
export async function removeBotShare(
  deps: {
    update: (
      botId: string,
      edit: (saved: Pick<Bot, 'shares'>) => Pick<BotHostUpdates, 'shares'>
    ) => Promise<Bot>
    devices: BotShareDevices | null
  },
  botId: string,
  shareId: string
): Promise<Bot> {
  let removed: BotShare | undefined
  const bot = await deps.update(botId, (saved) => {
    removed = saved.shares?.find((share) => share.shareId === shareId)
    return { shares: (saved.shares ?? []).filter((share) => share !== removed) }
  })
  // An invite never reached a device; an account keeps no other share on the bot (one per account).
  if (removed?.kind === 'account' && deps.devices) {
    const ended = await deps.devices.revokeBotShareDevices(botId, removed.accountId)
    if (!ended) {
      console.warn('[bots] a removed teammate’s devices are not all disconnected yet', { botId })
    }
  }
  return bot
}

/** A deleted bot's teammates lose every device on it; a failure is logged, never thrown at the delete. */
export async function revokeDeletedBotShareDevices(
  devices: BotShareDevices | null,
  botId: string
): Promise<void> {
  try {
    if (devices && !(await devices.revokeBotShareDevices(botId))) {
      console.warn('[bots] a deleted bot’s teammate devices are not all disconnected yet', {
        botId
      })
    }
  } catch (error) {
    console.warn('[bots] could not disconnect a deleted bot’s teammate devices', { botId, error })
  }
}
