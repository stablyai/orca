// What the host's share list changes for teammates' access: who is removed loses their devices, and a
// teammate reads the shared bot without the list of whom else it is shared with.
import type { Bot } from '../../../shared/bot-types'
import { botShareUsable, type BotShare } from '../../../shared/bots/bot-team-shares'
import { botHome } from '../../../shared/bots/bot-home-of'
import { botChatPeople } from '../../../shared/bots/bot-chat-people'
import type { Automation } from '../../../shared/automations/automation-definition'
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
  /** Rewrites each device row's name (kept only for older builds) after a share's name changed. */
  syncBotShareDeviceNames: () => Promise<void>
  /** The key teammates seal held messages to: this host's pairing E2EE key, null without one. */
  getE2EEPublicKey: () => string | null
  /** One of the owner's own paired computers, as known now: not a teammate's, not revoked or unknown. */
  isOwnerDevice: (deviceId: string) => boolean
  /** The share a teammate's device (their desktop or its phone) calls as, by the scope admission
   *  stamps on it; null for anyone else's. */
  teammateOfDevice: (deviceId: string) => { botId: string; accountId: string } | null
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
 *  and chats show, their own Home Chat in the Home slot, and its people as the Items filter names them
 *  (`shareViewer`). Its connectors, settings and the owner's chats stay on this host; the fields a Bot
 *  requires read empty, as for a shared agent whose host hasn't answered yet. */
export function botShareListedBots(
  bots: readonly Bot[],
  scope: Pick<BotShareCallerScope, 'botId' | 'accountId'>,
  ownerName: string | null = null
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
      chatSessionId: botHome(bot, { accountId: scope.accountId }),
      shareViewer: { accountId: scope.accountId, ownerName, teammates: botChatPeople(bot) }
    }))
}

/** The running automations made for that teammate on the agent, which their removal pauses. */
export function automationsOfTeammate(
  automations: readonly Pick<Automation, 'id' | 'enabled' | 'bot'>[],
  botId: string,
  accountId: string
): string[] {
  return automations.flatMap((automation) =>
    automation.enabled && automation.bot?.botId === botId && automation.bot.home === accountId
      ? [automation.id]
      : []
  )
}

/** Takes the share off the list, pauses the automations made for that teammate (kept, for the owner
 *  to resume or delete), then ends their devices on the agent at once. Their chats stay. */
export async function removeBotShare(
  deps: {
    update: (
      botId: string,
      edit: (saved: Pick<Bot, 'shares'>) => Pick<BotHostUpdates, 'shares'>
    ) => Promise<Bot>
    devices: Pick<BotShareDevices, 'revokeBotShareDevices'> | null
    automations: {
      list: () => readonly Pick<Automation, 'id' | 'enabled' | 'bot'>[]
      pause: (ids: readonly string[]) => Promise<void>
    }
  },
  botId: string,
  shareId: string
): Promise<Bot> {
  let removed: BotShare | undefined
  const bot = await deps.update(botId, (saved) => {
    removed = saved.shares?.find((share) => share.shareId === shareId)
    return { shares: (saved.shares ?? []).filter((share) => share !== removed) }
  })
  if (removed?.kind === 'account') {
    const theirs = automationsOfTeammate(deps.automations.list(), botId, removed.accountId)
    if (theirs.length > 0) {
      await deps.automations.pause(theirs)
    }
  }
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
