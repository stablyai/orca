// Who a bot is shared with, by Orca account or invited email: its owner adds and removes them in Orca.
import { randomUUID } from 'node:crypto'
import type { Bot } from '../../../../shared/bot-types'
import { withBotShareInvites, withBotSharesEmailed } from '../../../../shared/bots/bot-team-shares'
import {
  BotTeamSharesAdd,
  BotTeamSharesRemove,
  BotTeamSharesResend
} from '../../../../shared/rpc-contract/bots-team-shares-params'
import { defineMethod, InvalidArgumentError, type RpcContext } from '../core'
import { ownerOnly } from './bots-caller-gates'
import { removeBotShare } from '../../../bots/team-share/bot-share-access'
import { sendBotInviteEmail } from '../../../bots/team-share/bot-invite-email'

const OWNER_ONLY = 'Only your owner shares you with people, in Orca.'

/** Emails each invite and marks the ones that went out; one that didn't shows "Email not sent yet". */
async function emailInvites(
  context: RpcContext,
  bot: Bot,
  invites: readonly { shareId: string; email: string }[]
): Promise<{ bot: Bot; emailed: string[] }> {
  // One at a time: the cloud sends one invite per sharer at once and answers a second with 429.
  const emailed: string[] = []
  for (const invite of invites) {
    const email = { to: invite.email, agentName: bot.name }
    if (await sendBotInviteEmail(context.runtime.botCloudAuth, email)) {
      emailed.push(invite.shareId)
    }
  }
  if (emailed.length === 0) {
    return { bot, emailed }
  }
  const at = Date.now()
  const marked = await context.runtime.bots.update(bot.id, (saved) => ({
    shares: withBotSharesEmailed(saved.shares ?? [], new Set(emailed), at)
  }))
  return { bot: marked, emailed }
}

export const BOT_TEAM_SHARES_METHODS = [
  defineMethod({
    name: 'bots.teamShares.add',
    permission: 'workspace',
    share: 'not-shared',
    params: BotTeamSharesAdd,
    // added: the invites made now, each emailed before the answer; emails already on the list are kept.
    handler: async ({ botId, emails }, context) => {
      ownerOnly(context, OWNER_ONLY)
      const minted = new Set<string>()
      const saved = await context.runtime.bots.update(botId, (current) => ({
        shares: withBotShareInvites(current.shares ?? [], emails, () => {
          const shareId = randomUUID()
          minted.add(shareId)
          return { shareId, addedAt: Date.now() }
        })
      }))
      const made = (saved.shares ?? []).filter((share) => minted.has(share.shareId))
      const { bot, emailed } = await emailInvites(context, saved, made)
      console.info('[bots] people added to the share list', {
        botId,
        count: made.length,
        emailed: emailed.length,
        deviceId: context.pairedDeviceId ?? null
      })
      return { bot, added: (bot.shares ?? []).filter((share) => minted.has(share.shareId)) }
    }
  }),
  defineMethod({
    name: 'bots.teamShares.resend',
    permission: 'workspace',
    share: 'not-shared',
    params: BotTeamSharesResend,
    handler: async ({ botId, shareId }, context) => {
      ownerOnly(context, OWNER_ONLY)
      const saved = context.runtime.bots.list().find((entry) => entry.id === botId)
      const invite = saved?.shares?.find((share) => share.shareId === shareId)
      if (!saved || invite?.kind !== 'invite') {
        throw new InvalidArgumentError('That invite is no longer on the share list.')
      }
      const { bot, emailed } = await emailInvites(context, saved, [invite])
      return { bot, emailed: emailed.length > 0 }
    }
  }),
  defineMethod({
    name: 'bots.teamShares.remove',
    permission: 'workspace',
    share: 'not-shared',
    params: BotTeamSharesRemove,
    handler: async ({ botId, shareId }, context) => {
      ownerOnly(context, OWNER_ONLY)
      const bot = await removeBotShare(
        {
          update: (id, edit) => context.runtime.bots.update(id, edit),
          devices: context.runtime.botShareDevices
        },
        botId,
        shareId
      )
      console.info('[bots] person removed from the share list', {
        botId,
        shareId,
        deviceId: context.pairedDeviceId ?? null
      })
      return { bot }
    }
  })
]
