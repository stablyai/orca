// Who a bot is shared with, by Orca account or invited email: its owner adds and removes them in Orca.
import { randomUUID } from 'node:crypto'
import { withBotShareInvites } from '../../../../shared/bots/bot-team-shares'
import {
  BotTeamSharesAdd,
  BotTeamSharesRemove
} from '../../../../shared/rpc-contract/bots-team-shares-params'
import { defineMethod } from '../core'
import { ownerOnly } from './bots-caller-gates'

const OWNER_ONLY = 'Only your owner shares you with people, in Orca.'

export const BOT_TEAM_SHARES_METHODS = [
  defineMethod({
    name: 'bots.teamShares.add',
    permission: 'workspace',
    params: BotTeamSharesAdd,
    // added: the invites made now, each of which gets an invite email; emails already on the list are kept.
    handler: async ({ botId, emails }, context) => {
      ownerOnly(context, OWNER_ONLY)
      const minted = new Set<string>()
      const bot = await context.runtime.bots.update(botId, (saved) => ({
        shares: withBotShareInvites(saved.shares ?? [], emails, () => {
          const shareId = randomUUID()
          minted.add(shareId)
          return { shareId, addedAt: Date.now() }
        })
      }))
      const added = (bot.shares ?? []).filter((share) => minted.has(share.shareId))
      console.info('[bots] people added to the share list', {
        botId,
        count: added.length,
        deviceId: context.pairedDeviceId ?? null
      })
      return { bot, added }
    }
  }),
  defineMethod({
    name: 'bots.teamShares.remove',
    permission: 'workspace',
    params: BotTeamSharesRemove,
    handler: async ({ botId, shareId }, context) => {
      ownerOnly(context, OWNER_ONLY)
      const bot = await context.runtime.bots.update(botId, (saved) => ({
        shares: (saved.shares ?? []).filter((share) => share.shareId !== shareId)
      }))
      console.info('[bots] person removed from the share list', {
        botId,
        shareId,
        deviceId: context.pairedDeviceId ?? null
      })
      return { bot }
    }
  })
]
