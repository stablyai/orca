// teams.*: this host's Microsoft Teams sign-in, which bots may use it, and the verbs that act through
// it. Tokens stay on this host; clients see who signed in and what Teams allowed.
import { BOT_TOKEN_ENDED, botOfToken } from '../../../bots/bot-of-caller'
import { getTeamsConnect } from '../../../teams/teams-connect'
import {
  findTeamsPlaces,
  postTeamsMessage,
  reactToTeamsMessage,
  readTeamsPlace
} from '../../../teams/teams-actions'
import {
  TeamsBotSetParams,
  TeamsDisconnectParams,
  TeamsFindParams,
  TeamsPostParams,
  TeamsReactParams,
  TeamsReadParams,
  TeamsSignInFlowParams,
  TeamsSignInStartParams,
  TeamsSignInWaitParams,
  TeamsStatusParams
} from '../../../../shared/rpc-contract/teams-params'
import type { TeamsStatusView } from '../../../../shared/teams/teams-connect-types'
import { botOtherAskers } from '../../../../shared/google/google-who-can-ask-warning'
import { defineMethod, InvalidArgumentError, type RpcContext } from '../core'
import { rpcCallerOperationKey } from '../callers/rpc-caller-identity'

const OWNER_ONLY = 'Only your owner can change Microsoft Teams on this computer; ask them in Orca.'

function flowOwner({ caller }: Pick<RpcContext, 'caller'>): string {
  if (!caller) {
    throw new Error('This client cannot sign Microsoft Teams in on this computer.')
  }
  return rpcCallerOperationKey(caller)
}

/** A bot's token, even an ended one, is refused; no token is the owner's own terminal or agent. */
function refuseFromBot(botToken: string | undefined, context: RpcContext): void {
  if (botOfToken(context.runtime, botToken, context.pairedDeviceId).kind !== 'owner') {
    throw new InvalidArgumentError(OWNER_ONLY)
  }
}

/** A bot's run acts in Teams only once its owner turned Teams on for it. */
function refuseBotWithoutTeams(botToken: string | undefined, context: RpcContext): void {
  const caller = botOfToken(context.runtime, botToken, context.pairedDeviceId)
  if (caller.kind === 'ended') {
    throw new InvalidArgumentError(BOT_TOKEN_ENDED)
  }
  if (caller.kind === 'bot' && caller.bot.teams !== true) {
    throw new InvalidArgumentError(
      `Microsoft Teams is off for ${caller.bot.name}. Ask your owner to run \`orca teams bot "${caller.bot.name}" --on\`.`
    )
  }
}

export const TEAMS_METHODS = [
  defineMethod({
    name: 'teams.status',
    permission: 'workspace',
    params: TeamsStatusParams,
    handler: async ({ botToken }, ctx): Promise<TeamsStatusView> => {
      const caller = botOfToken(ctx.runtime, botToken, ctx.pairedDeviceId)
      const bots =
        caller.kind === 'owner' && ctx.runtime.bots.enabled()
          ? ctx.runtime.bots
              .list()
              .filter((bot) => bot.teams === true)
              .map((bot) => ({ id: bot.id, name: bot.name }))
          : []
      return { account: await getTeamsConnect().account(), bots }
    }
  }),
  defineMethod({
    name: 'teams.signIn.start',
    permission: 'workspace',
    params: TeamsSignInStartParams,
    handler: async ({ botToken, tenantId, clientId, chatsOnly }, ctx) => {
      refuseFromBot(botToken, ctx)
      return getTeamsConnect().startSignIn(flowOwner(ctx), {
        tenantId,
        clientId,
        channels: chatsOnly !== true
      })
    }
  }),
  defineMethod({
    name: 'teams.signIn.wait',
    permission: 'workspace',
    params: TeamsSignInWaitParams,
    handler: async ({ flowId, afterRevision }, ctx) =>
      getTeamsConnect().waitSignIn(flowOwner(ctx), flowId, afterRevision, ctx.signal)
  }),
  defineMethod({
    name: 'teams.signIn.cancel',
    permission: 'workspace',
    params: TeamsSignInFlowParams,
    handler: async ({ flowId }, ctx) => getTeamsConnect().cancelSignIn(flowOwner(ctx), flowId)
  }),
  defineMethod({
    name: 'teams.disconnect',
    permission: 'workspace',
    params: TeamsDisconnectParams,
    handler: async ({ botToken }, ctx) => {
      refuseFromBot(botToken, ctx)
      return getTeamsConnect().disconnect()
    }
  }),
  defineMethod({
    name: 'teams.bot.set',
    permission: 'workspace',
    params: TeamsBotSetParams,
    handler: async ({ botToken, botId, on }, ctx) => {
      refuseFromBot(botToken, ctx)
      ctx.runtime.bots.assertEnabled()
      const bot = await ctx.runtime.bots.update(botId, () => ({ teams: on }))
      const askers = on ? botOtherAskers(bot) : []
      return {
        bot: { id: bot.id, name: bot.name, teams: bot.teams === true },
        ...(askers.length > 0
          ? {
              warning: `${askers.join(', ')} can ask ${bot.name}, so they can have it read and post in Teams as you.`
            }
          : {})
      }
    }
  }),
  defineMethod({
    name: 'teams.find',
    permission: 'workspace',
    params: TeamsFindParams,
    handler: async ({ botToken, query, limit }, ctx) => {
      refuseBotWithoutTeams(botToken, ctx)
      return findTeamsPlaces(getTeamsConnect().graph, query, limit)
    }
  }),
  defineMethod({
    name: 'teams.read',
    permission: 'workspace',
    params: TeamsReadParams,
    handler: async ({ botToken, ref, limit }, ctx) => {
      refuseBotWithoutTeams(botToken, ctx)
      return readTeamsPlace(getTeamsConnect().graph, ref, limit)
    }
  }),
  defineMethod({
    name: 'teams.post',
    permission: 'workspace',
    params: TeamsPostParams,
    handler: async ({ botToken, ref, text }, ctx) => {
      refuseBotWithoutTeams(botToken, ctx)
      return postTeamsMessage(getTeamsConnect().graph, ref, text)
    }
  }),
  defineMethod({
    name: 'teams.react',
    permission: 'workspace',
    params: TeamsReactParams,
    handler: async ({ botToken, ref, emoji }, ctx) => {
      refuseBotWithoutTeams(botToken, ctx)
      return reactToTeamsMessage(getTeamsConnect().graph, ref, emoji)
    }
  })
] as const
