import {
  BotActivityRead,
  BotAvatarRead,
  BotAvatarUpload,
  BotChatReset,
  BotDelete,
  BotRoster,
  BotSessionStart,
  BotSkillProjectsScan,
  BotUpdate,
  type BotChatResetParams,
  type BotUpdateParams
} from '../../../../shared/rpc-contract/bots-params'
import { googleSetupRuns } from '../../../google/google-setup-runs'
import { readSharedBotActivity } from '../../../bots/bot-activity-host'
import {
  requireStructuredHost,
  runtimeBotChats,
  startBotSession,
  botOnAgent
} from '../../../bots/bot-chat-session'
import { readPairedBotRosters, withPairedBotRosters } from '../../../bots/paired-bot-rosters'
import { botOfSession } from '../../../bots/bot-session-tabs'
import { openEmptyBotChat, runtimeBotChatTreeHost } from '../../../bots/bot-chat-tree-host'
import { forgetDeletedBotTools } from './bots-tools'
import { composioBotsOf } from './bots-composio'
import { ownerOnly } from './bots-caller-gates'
import { BOT_CREATE_METHOD } from './bots-create'
import { BOT_AGENT_CHOICES_METHOD } from './bots-agent-choices'
import { BOT_CHATS_METHODS, botChatsSummary, readBotChats } from './bots-chats'
import { BOT_CHAT_TREE_METHODS } from './bots-chat-tree'
import { BOT_MEMORY_METHODS } from './bots-memory'
import { BOT_KICKOFF_METHODS } from './bots-kickoff'
import { namedOrCallerBot } from './bots-caller-bot'
import { releaseDeletedBotLinks } from './bots-home-release'
import { dropUnreadBotRequests } from './orchestration/messaging/bot-request-outcome'
import { releaseHeldBotMail } from '../../../bots/bot-paused-mail'
import { defineMethod, InvalidArgumentError, type RpcContext } from '../core'
import { botSkillProjectViews, relinkBotSkills } from '../../../bots/bot-skill-projects'
import { botOwnSkillsView, linkBotOwnSkills } from '../../../bots/bot-own-skills'
import { botHomeFolder } from '../../../bots/bot-home'
import { listedBotsFacts } from './bots-list-facts'
import { normalizeBotSidebarView } from '../../../../shared/bots/bot-sidebar-view'
import { orcaSignInServer } from '../../../bots/orca-sign-in-server'

async function updateBot(params: BotUpdateParams, context: RpcContext) {
  if (params.updates.slackMirror !== undefined) {
    ownerOnly(context, 'Only the owner can change what posts to Slack')
  }
  const { members, addMembers: added, permissionMode } = params.updates
  if (members !== undefined || added !== undefined || permissionMode !== undefined) {
    ownerOnly(context, 'Only your owner changes your Who can ask or permissions, in Orca.')
  }
  const bot = await context.runtime.bots.update(params.botId, params.updates)
  if (params.updates.skillProjects !== undefined) {
    relinkBotSkills(bot, context.runtime.listRepos())
  }
  if (params.updates.agent !== undefined) {
    void linkBotOwnSkills(botHomeFolder(bot)).catch(() => {})
  }
  if (params.updates.paused === true) {
    await dropUnreadBotRequests(context.runtime, bot.id, 'paused')
  } else if (params.updates.paused === false && !bot.paused) {
    // Every resume, not only a seen transition: a pause still being saved reads as unpaused here.
    releaseHeldBotMail(context.runtime, bot)
  }
  const { removeMember, removeMembers = [], addMembers = [] } = params.updates
  // Who can ask decides who may make this host run commands, so the device that changed it is kept on record.
  const changes = [
    ...[...(removeMember ? [removeMember] : []), ...removeMembers].map((key) => ({
      change: 'removed',
      key
    })),
    ...addMembers.map((member) => ({ change: 'added', key: member }))
  ]
  for (const { change, key } of changes) {
    console.info(`[bots] person ${change} ${change === 'added' ? 'to' : 'from'} Who can ask`, {
      botId: params.botId,
      source: key.source ?? 'slack',
      memberId: key.id,
      deviceId: context.pairedDeviceId ?? null
    })
  }
  return { bot }
}

/** New Home Chat, for the owner only: from Orca, a script, or the bot's Home Chat on a turn they typed. */
async function newHomeChat(params: BotChatResetParams, context: RpcContext) {
  const { runtime } = context
  runtime.bots.assertEnabled()
  const { bot, caller, callerBot } = namedOrCallerBot(params, context)
  // A bot's threads, runs and connector messages answer other people, who can't start one.
  if (
    caller &&
    callerBot &&
    (callerBot.id !== bot.id ||
      caller !== bot.chatSessionId ||
      runtime.getExternalConversationSeam()?.deliveredTurn(caller) ||
      !(await ownerTypedLatest(runtime, caller)))
  ) {
    throw new InvalidArgumentError('Only the bot’s owner can start a new Home Chat.')
  }
  const sessionId = await runtimeBotChats(runtime).reset(bot.id)
  // Mail its old Chat never read is not carried over.
  await dropUnreadBotRequests(runtime, bot.id, 'new-chat', bot.chatSessionId ?? undefined)
  return { sessionId }
}

/** Whether the chat's latest message is its owner's own, not an automation run's, a connector's or Orca's. */
async function ownerTypedLatest(runtime: RpcContext['runtime'], sessionId: string) {
  const reads = await (await requireStructuredHost(runtime)).journalReads(sessionId)
  const body = (await reads.promptItem('last'))?.body
  return body?.kind === 'message' && !body.from && !body.origin && !body.memorySource
}

// Off, nothing creates a bot or opens its Chat; listing, editing and deleting stay.
export const BOT_METHODS = [
  defineMethod({
    name: 'bots.list',
    permission: 'workspace',
    params: null,
    // webhooks: whether this host's Orca Cloud takes them, so a bot can be offered webhook.call;
    // threadReplies: whether it binds an event's run to its thread, for --results-to thread.
    // githubEvents2: whether it sends GitHub's newer events and label=, for trigger-options.
    // githubWorkflows: whether it sends github.workflow_finished, for trigger-options.
    // waits: each bot's waits still waiting, for its row; needsYou: its unstale Needs you items, for phones.
    // connectorNeedsSignIn: Orca Cloud refused this host's sign-in, so nothing reaches its bots.
    // connectorStatus: signed out, needs sign-in (the app is signed in but the connector refuses it),
    // can't reach Orca Cloud, refused (connectorMessage says why), or ok; absent without Orca Cloud.
    // signInServer: this host's name when it is a headless server, whose signed-out copy names it;
    // null with a window (an older host omits it, so the CLI can't tell which).
    handler: async (_params, { runtime }) => {
      const webhooks = runtime.getWebhooks()
      const listing = runtime.bots.listing()
      const signInServer = orcaSignInServer(runtime)
      return {
        ...listing,
        // The host's Bot options, so a phone lists its bots as this sidebar does.
        botSidebarView: normalizeBotSidebarView(runtime.getUIState().botSidebarView),
        ...(listing.bots.length > 0 ? await listedBotsFacts(runtime) : {}),
        ...(webhooks ? { webhooks: webhooks.advertised() } : {}),
        ...(runtime.getConnectorCloud()?.botListFacts() ?? {
          threadReplies: false,
          githubEvents2: false,
          githubWorkflows: false
        }),
        signInServer
      }
    }
  }),
  defineMethod({
    name: 'bots.roster',
    permission: 'workspace',
    params: BotRoster,
    handler: async (params, context) => {
      const { runtime } = context
      // A session id names a chat only on its own host, so a paired client's claim names none.
      const caller =
        context.pairedDeviceId === undefined && params.callerSessionId
          ? botOfSession(runtime.bots, params.callerSessionId)
          : null
      const callerSessionId = caller ? params.callerSessionId : undefined
      const records = runtime.bots.list()
      // A paired client reads each server itself, so only a host's own callers fan out.
      const paired =
        params.allComputers && context.pairedDeviceId === undefined
          ? readPairedBotRosters(runtime)
          : null
      const own = await Promise.all(
        (await runtime.bots.roster()).map(async (rosterEntry) => {
          const bot = records.find((record) => record.id === rosterEntry.id)
          // Unreadable chats leave the list printing, without that line.
          const chats =
            bot && !params.withoutChats
              ? await Promise.resolve()
                  .then(() => readBotChats(runtime, bot, callerSessionId ?? null))
                  .then(botChatsSummary)
                  .catch(() => null)
              : null
          const entry = chats ? { ...rosterEntry, chats } : rosterEntry
          return entry.id === caller?.id ? { ...entry, self: true as const } : entry
        })
      )
      return paired ? withPairedBotRosters(own, await paired) : { bots: own }
    }
  }),
  BOT_CREATE_METHOD,
  BOT_AGENT_CHOICES_METHOD,
  ...BOT_CHATS_METHODS,
  ...BOT_CHAT_TREE_METHODS,
  ...BOT_MEMORY_METHODS,
  defineMethod({
    name: 'bots.update',
    permission: 'workspace',
    params: BotUpdate,
    handler: updateBot
  }),
  defineMethod({
    name: 'bots.skillProjects.scan',
    permission: 'workspace',
    params: BotSkillProjectsScan,
    handler: async (params, { runtime }) => {
      const bot = params.botId
        ? runtime.bots.list().find((entry) => entry.id === params.botId)
        : undefined
      const [projects, own] = await Promise.all([
        botSkillProjectViews(params.repoIds, runtime.listRepos()),
        bot ? botOwnSkillsView(botHomeFolder(bot)) : undefined
      ])
      return own ? { projects, own } : { projects }
    }
  }),
  defineMethod({
    name: 'bots.avatar.upload',
    permission: 'workspace',
    params: BotAvatarUpload,
    handler: async (params, { runtime }) => ({
      bot: await runtime.bots.setAvatarImage(
        params.botId,
        Buffer.from(params.png, 'base64'),
        params.expectedAvatarRevision
      )
    })
  }),
  defineMethod({
    name: 'bots.avatar.read',
    permission: 'workspace',
    params: BotAvatarRead,
    handler: async (params, { runtime }) => ({
      png: (await runtime.bots.readAvatarImage(params.botId))?.toString('base64') ?? null
    })
  }),
  defineMethod({
    name: 'bots.activity',
    permission: 'workspace',
    params: BotActivityRead,
    handler: async (params, { runtime }) => ({
      activity: await readSharedBotActivity(runtime, params.botId)
    })
  }),
  defineMethod({
    name: 'bots.delete',
    permission: 'workspace',
    params: BotDelete,
    handler: async (params, { runtime }) => {
      const bot = runtime.bots.list().find((entry) => entry.id === params.botId)
      if (bot) {
        // Listed first so a crash mid-delete still cleans up; nothing goes while the bot is here.
        await composioBotsOf(runtime).willDelete(bot.id)
        await forgetDeletedBotTools(runtime, bot)
      }
      const deleted = await runtime.bots.delete(params)
      if (bot) {
        releaseDeletedBotLinks(runtime, bot)
        await composioBotsOf(runtime).forget(bot.id)
      }
      await dropUnreadBotRequests(runtime, params.botId, 'deleted')
      googleSetupRuns().forget(params.botId)
      return deleted
    }
  }),
  ...BOT_KICKOFF_METHODS,
  defineMethod({
    name: 'bots.chat.reset',
    permission: 'workspace',
    params: BotChatReset,
    handler: newHomeChat
  }),
  defineMethod({
    // A new conversation beside the Chat, started the way the bot's thread sessions are.
    name: 'bots.session.start',
    permission: 'workspace',
    params: BotSessionStart,
    handler: async (params, { runtime }) => {
      runtime.bots.assertEnabled()
      const bot = runtime.bots.list().find((entry) => entry.id === params.botId)
      if (!bot) {
        throw new Error('bot_not_found')
      }
      const onAgent = botOnAgent(bot, params.agent)
      // Like a blank page: an empty chat already open is the new chat, not one more.
      const empty = await openEmptyBotChat(runtimeBotChatTreeHost(runtime), onAgent).catch(
        (error: unknown) => {
          console.error('[bots] failed to look for an empty chat to reuse:', error)
          return null
        }
      )
      return { sessionId: empty ?? (await startBotSession(runtime, onAgent)) }
    }
  })
]
