// `bots.cliq.*`: a bot's own Cliq bots and the account's Zoho Cliq sign-ins, as this host's own Orca
// account, for whichever of its clients asks. Signing in is `bots.connect.*` with source `cliq`.
import {
  BotCliqBotOrg,
  BotCliqBotState,
  BotCliqMembers,
  BotCliqOrg
} from '../../../../shared/rpc-contract/bots-connector-setup-params'
import { botCliqBots, type Bot, type BotCliqBot } from '../../../../shared/bot-types'
import { BOT_SLACK_DESKTOP_ERRORS } from '../../../../shared/connector-bot-slack-contract'
import { CONNECT_ACCOUNT_CHANGED } from '../../../connector-cloud/connector-connect'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod } from '../core'
import { withHostCloudClient } from './bots-slack'

/** The bot's Cliq organizations after one is set up (added, or its details refreshed) or removed. */
export function nextCliqBots(
  bot: Pick<Bot, 'cliqBots'>,
  change: { set: BotCliqBot } | { remove: string }
): BotCliqBot[] {
  const links = botCliqBots(bot)
  if ('remove' in change) {
    return links.filter((link) => link.orgId !== change.remove)
  }
  const { set } = change
  return links.some((link) => link.orgId === set.orgId)
    ? links.map((link) => (link.orgId === set.orgId ? { ...link, ...set } : link))
    : [...links, set]
}

// The cloud's answer stands even if the local record cannot follow it (e.g. the bot was just deleted).
async function recordCliq(
  runtime: Pick<OrcaRuntimeService, 'bots'>,
  botId: string,
  change: Parameters<typeof nextCliqBots>[1]
): Promise<void> {
  try {
    await runtime.bots.update(botId, (bot) => ({ cliqBots: nextCliqBots(bot, change) }))
  } catch (error) {
    console.error('Failed to record the bot’s Cliq bot:', error)
  }
}

// `accounts-admin`: these hold the host's integration credentials (rpc-method-permission.ts).
export const BOT_CLIQ_METHODS = [
  defineMethod({
    name: 'bots.cliq.orgs',
    permission: 'accounts-admin',
    params: null,
    handler: async (_params, context) =>
      withHostCloudClient(context, (client) => client.cliqState())
  }),
  defineMethod({
    name: 'bots.cliq.forgetOrg',
    permission: 'accounts-admin',
    params: BotCliqOrg,
    handler: async ({ orgId }, context) =>
      withHostCloudClient(context, (client) => client.forgetCliqOrg(orgId))
  }),
  defineMethod({
    name: 'bots.cliq.state',
    permission: 'accounts-admin',
    params: BotCliqBotState,
    handler: async ({ botId, orgId }, context) =>
      withHostCloudClient(context, (client) => client.botCliqState(botId, orgId))
  }),
  defineMethod({
    name: 'bots.cliq.setUp',
    permission: 'accounts-admin',
    params: BotCliqBotOrg,
    handler: async ({ botId, orgId }, context) => {
      const { runtime } = context
      const cloud = runtime.getConnectorCloud()
      const setUp = async () => {
        // A set-up answered after the host's account changed belongs to the old account: not recorded.
        const account = cloud?.signedInAccount() ?? null
        const result = await withHostCloudClient(context, (client) =>
          client.setUpCliqBot(botId, orgId)
        )
        if (result.ok && (cloud?.signedInAccount() ?? null) !== account) {
          return { ok: false as const, error: CONNECT_ACCOUNT_CHANGED }
        }
        if (result.ok && result.value.state !== 'installed') {
          return { ok: false as const, error: BOT_SLACK_DESKTOP_ERRORS.failed }
        }
        if (result.ok && result.value.state === 'installed') {
          const { orgName, dataCenter } = result.value
          await recordCliq(runtime, botId, { set: { orgId, orgName: orgName ?? '', dataCenter } })
        }
        return result
      }
      // A bot with no connector yet is known to the cloud only once this host says hello.
      return cloud ? cloud.withConnection(setUp) : setUp()
    }
  }),
  defineMethod({
    name: 'bots.cliq.remove',
    permission: 'accounts-admin',
    params: BotCliqBotOrg,
    handler: async ({ botId, orgId }, context) => {
      const removed = await withHostCloudClient(context, (client) =>
        client.removeCliqBot(botId, orgId)
      )
      if (removed.ok) {
        await recordCliq(context.runtime, botId, { remove: orgId })
      }
      return removed
    }
  }),
  defineMethod({
    name: 'bots.cliq.members',
    permission: 'accounts-admin',
    params: BotCliqMembers,
    handler: async ({ botId, orgId, query }, context) =>
      withHostCloudClient(context, (client) => client.cliqMembers(botId, orgId, query))
  })
]
