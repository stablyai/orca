// `bots.slack.*`: a bot's Slack app and the account's Slack config grants, as this host's own Orca
// account, for whichever of its clients asks (its own window, a paired desktop or the web client).
import {
  BOT_SLACK_DESKTOP_ERRORS,
  type BotSlackResult
} from '../../../../shared/connector-bot-slack-contract'
import {
  BotSlackBot,
  BotSlackGrant,
  BotSlackMembers,
  BotSlackPostAs,
  BotSlackSetUp,
  BotSlackTeam
} from '../../../../shared/rpc-contract/bots-connector-setup-params'
import {
  withBotsCloudClient,
  type BotsCloudClient
} from '../../../connector-cloud/bots-cloud-client'
import { botSlackApps, type Bot, type BotSlackApp } from '../../../../shared/bot-types'
import { CONNECT_ACCOUNT_CHANGED } from '../../../connector-cloud/connector-connect'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod, type RpcContext } from '../core'

/** The bot's Slack workspaces after one is set up (added, or its app replaced) or removed. */
export function nextSlackApps(
  bot: Pick<Bot, 'slack' | 'slackApps'>,
  change: { set: BotSlackApp } | { remove: string | undefined }
): BotSlackApp[] {
  const apps = botSlackApps(bot)
  if ('remove' in change) {
    return change.remove === undefined ? [] : apps.filter((app) => app.teamId !== change.remove)
  }
  const { set } = change
  return apps.some((app) => app.teamId === set.teamId)
    ? apps.map((app) => (app.teamId === set.teamId ? { ...app, ...set } : app))
    : [...apps, set]
}

/** Runs `run` with this host's cloud client, as the host's own Orca account. */
export function withHostCloudClient<T>(
  context: RpcContext,
  run: (client: BotsCloudClient) => Promise<BotSlackResult<T>>
): Promise<BotSlackResult<T>> {
  return withBotsCloudClient(context.runtime.getConnectorCloud(), run)
}

// The cloud's answer stands even if the local record cannot follow it (e.g. the bot was just deleted).
async function recordSlack(
  runtime: Pick<OrcaRuntimeService, 'bots'>,
  botId: string,
  change: Parameters<typeof nextSlackApps>[1],
  expected?: readonly BotSlackApp[]
): Promise<void> {
  try {
    await runtime.bots.update(botId, (bot) => {
      if ('remove' in change) {
        const apps = botSlackApps(bot)
        const next = apps.filter(
          (app) =>
            (change.remove !== undefined && app.teamId !== change.remove) ||
            (expected !== undefined &&
              !expected.some((saved) => saved.teamId === app.teamId && saved.appId === app.appId))
        )
        return next.length === apps.length ? null : { slackApps: next }
      }
      return { slackApps: nextSlackApps(bot, change) }
    })
  } catch (error) {
    console.error('Failed to record the bot’s Slack app:', error)
  }
}

// `accounts-admin`: these hold the host's integration credentials (rpc-method-permission.ts).
export const BOT_SLACK_METHODS = [
  defineMethod({
    name: 'bots.slack.saveGrant',
    permission: 'accounts-admin',
    params: BotSlackGrant,
    handler: async ({ refreshToken }, context) =>
      withHostCloudClient(context, (client) => client.saveSlackGrant(refreshToken))
  }),
  defineMethod({
    name: 'bots.slack.forgetGrant',
    permission: 'accounts-admin',
    params: BotSlackTeam,
    handler: async ({ teamId }, context) =>
      withHostCloudClient(context, (client) => client.forgetSlackGrant(teamId))
  }),
  defineMethod({
    name: 'bots.slack.state',
    permission: 'accounts-admin',
    params: BotSlackBot,
    handler: async ({ botId, teamId }, context) =>
      withHostCloudClient(context, (client) => client.slackState(botId, teamId))
  }),
  defineMethod({
    name: 'bots.slack.setUpApp',
    permission: 'accounts-admin',
    params: BotSlackSetUp,
    handler: async ({ botId, teamId }, context) => {
      const { runtime } = context
      const cloud = runtime.getConnectorCloud()
      const setUp = async () => {
        // A set-up answered after the host's account changed belongs to the old account: not recorded.
        const account = cloud?.signedInAccount() ?? null
        const result = await withHostCloudClient(context, (client) =>
          client.setUpSlackApp(botId, teamId)
        )
        if (result.ok && (cloud?.signedInAccount() ?? null) !== account) {
          return { ok: false as const, error: CONNECT_ACCOUNT_CHANGED }
        }
        if (result.ok) {
          await recordSlack(runtime, botId, { set: { appId: result.value.appId, teamId } })
        }
        return result
      }
      // A bot with no connector yet is known to the cloud only once this host says hello.
      return cloud ? cloud.withConnection(setUp) : setUp()
    }
  }),
  // Another signed-in Orca account (a paired desktop's own) creates the app with its grant; the code
  // is spent only by that desktop's own cloud session, never through any runtime's RPC.
  defineMethod({
    name: 'bots.slack.handOff',
    permission: 'accounts-admin',
    params: BotSlackSetUp,
    handler: async ({ botId, teamId }, context) => {
      const cloud = context.runtime.getConnectorCloud()
      const handOff = () =>
        withHostCloudClient(context, (client) => client.handOffSlackApp(botId, teamId))
      return cloud ? cloud.withConnection(handOff) : handOff()
    }
  }),
  // After a hand-off: the app is recorded as the cloud reads it for this host, not as the client says.
  defineMethod({
    name: 'bots.slack.adoptApp',
    permission: 'accounts-admin',
    params: BotSlackSetUp,
    handler: async ({ botId, teamId }, context) => {
      const state = await withHostCloudClient(context, (client) => client.slackState(botId, teamId))
      if (!state.ok) {
        return state
      }
      if (
        (state.value.state !== 'created' && state.value.state !== 'installed') ||
        state.value.teamId !== teamId
      ) {
        return { ok: false as const, error: BOT_SLACK_DESKTOP_ERRORS.failed }
      }
      await recordSlack(context.runtime, botId, { set: { appId: state.value.appId, teamId } })
      return { ok: true as const, value: undefined }
    }
  }),
  defineMethod({
    name: 'bots.slack.remove',
    permission: 'accounts-admin',
    params: BotSlackBot,
    handler: async ({ botId, teamId }, context) => {
      const cloud = context.runtime.getConnectorCloud()
      const account = cloud?.signedInAccount(true) ?? null
      const bot = context.runtime.bots.list().find((saved) => saved.id === botId)
      const expected = bot ? botSlackApps(bot) : []
      const removed = await withHostCloudClient(context, async (client) => {
        if (teamId !== undefined) {
          const state = await client.slackState(botId, teamId)
          if (!state.ok) {
            return state
          }
          // An older service ignores the workspace selector; never remove its other workspace.
          if (state.value.state === 'not_created' || state.value.teamId !== teamId) {
            return { ok: true as const, value: undefined }
          }
          const appId = 'appId' in state.value ? state.value.appId : undefined
          if (
            appId !== undefined &&
            !expected.some((saved) => saved.teamId === teamId && saved.appId === appId)
          ) {
            return { ok: false as const, error: 'connection_changed' }
          }
        }
        return client.removeSlackApp(botId, teamId)
      })
      if ((cloud?.signedInAccount(true) ?? null) !== account) {
        return { ok: false as const, error: CONNECT_ACCOUNT_CHANGED }
      }
      // Older services can refuse removal when the app or its install is already gone.
      if (
        removed.ok ||
        [
          'not_installed',
          'app_not_found',
          'invalid_app_id',
          'token_revoked',
          'account_inactive'
        ].includes(removed.error)
      ) {
        await recordSlack(context.runtime, botId, { remove: teamId }, expected)
        return { ok: true as const, value: undefined }
      }
      return removed
    }
  }),
  // What messages typed at the bot's computer post as in Slack: at once for the after-install pick,
  // else an install link whoever set the bot up approves.
  defineMethod({
    name: 'bots.slack.setPostAs',
    permission: 'accounts-admin',
    params: BotSlackPostAs,
    handler: async ({ botId, ...request }, context) =>
      withHostCloudClient(context, (client) => client.setSlackPostAs(botId, { v: 1, ...request }))
  }),
  defineMethod({
    name: 'bots.slack.members',
    permission: 'accounts-admin',
    params: BotSlackMembers,
    handler: async ({ botId, query, teamId }, context) =>
      withHostCloudClient(context, (client) => client.slackMembers(botId, query, teamId))
  })
]
