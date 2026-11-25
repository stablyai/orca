// What the host's share list changes for teammates' access: who is removed loses their devices, and a
// teammate reads the shared bot without the list of whom else it is shared with.
import type { Bot } from '../../../shared/bot-types'
import { botShareUsable, type BotShare } from '../../../shared/bots/bot-team-shares'
import type {
  BotShareProvisionedPhone,
  BotShareProvisionPhoneParams
} from '../../../shared/bots/bot-share-phone'
import type { BotHostUpdates } from '../../../shared/rpc-contract/bots-params'
import type { BotShareCallerScope } from '../../runtime/rpc/callers/rpc-caller-scope'
import type { BotShareOfferMint } from '../bot-team-share-deliveries'
import type {
  ConnectorDelivery,
  ConnectorDeliveryResult
} from '../../../shared/connectors/connector-cloud-contract'

/** The RPC server's teammate devices; null until it starts, and on a host without one. */
export type BotShareDevices = {
  mintBotShareOffer: BotShareOfferMint
  /** One teammate's devices with `accountId`, else every device on the bot; false if not all ended. */
  revokeBotShareDevices: (botId: string, accountId?: string) => Promise<boolean>
  /** A key for a teammate's phone, asked for by their computer's share device `parentDeviceId`. */
  provisionBotSharePhone: (
    parentDeviceId: string,
    params: BotShareProvisionPhoneParams
  ) => Promise<BotShareProvisionedPhone>
  /** Ends a phone `parentDeviceId` asked for; false when it isn't one of that computer's. */
  revokeBotSharePhone: (parentDeviceId: string, deviceId: string) => Promise<boolean>
  /** The key teammates seal held messages to: this host's pairing E2EE key, null without one. */
  getE2EEPublicKey: () => string | null
  /** Each bot's teammates (accounts) with a share device on it. */
  reachedAccounts: () => ReadonlyMap<string, ReadonlySet<string>>
  deliverBotShareHeldMessage: (
    delivery: Extract<ConnectorDelivery, { kind: 'share_send' }>
  ) => Promise<ConnectorDeliveryResult>
}

/** Whether the bot is still shared with the account: every teammate device stands on this alone. */
export function botSharedWithAccount(
  bots: readonly Pick<Bot, 'id' | 'shares'>[],
  grant: { botId: string; accountId: string }
): boolean {
  const bot = bots.find((entry) => entry.id === grant.botId)
  return (
    bot?.shares?.some(
      (share) =>
        share.kind === 'account' && share.accountId === grant.accountId && botShareUsable(share)
    ) ?? false
  )
}

/** The bots a teammate's share connection lists: the shared bot alone, with only what its row, avatar
 *  and chats show. Its people, connectors, settings and the owner's chats stay on this host; the
 *  fields a Bot requires read empty, as for a shared agent whose host hasn't answered yet. */
export function botShareListedBots(
  bots: readonly Bot[],
  scope: Pick<BotShareCallerScope, 'botId'>
): Bot[] {
  return bots
    .filter((bot) => bot.id === scope.botId)
    .map((bot) => ({
      id: bot.id,
      name: bot.name,
      hostId: bot.hostId,
      folder: bot.folder,
      folderWorkspaceId: bot.folderWorkspaceId,
      agent: bot.agent,
      avatar: bot.avatar,
      avatarColor: bot.avatarColor,
      avatarOutfit: bot.avatarOutfit,
      generatedOverMascot: bot.generatedOverMascot,
      avatarRevision: bot.avatarRevision,
      avatarRevisionEpoch: bot.avatarRevisionEpoch,
      paused: bot.paused,
      createdAt: bot.createdAt,
      updatedAt: bot.updatedAt,
      notifications: { needsPermission: false, taskComplete: false, couldNotFinish: false },
      members: [],
      slack: null,
      linear: null,
      github: null,
      chatSessionId: null
    }))
}

/** Takes the share off the list, then ends that account's devices on the bot at once. */
export async function removeBotShare(
  deps: {
    update: (
      botId: string,
      edit: (saved: Pick<Bot, 'shares'>) => Pick<BotHostUpdates, 'shares'>
    ) => Promise<Bot>
    devices: Pick<BotShareDevices, 'revokeBotShareDevices'> | null
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
