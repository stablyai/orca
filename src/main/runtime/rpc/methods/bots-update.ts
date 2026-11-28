// `bots.update`: the owner-only fields refused to anyone else, then the update and what follows it.
import type { BotUpdateParams } from '../../../../shared/rpc-contract/bots-params'
import { ownerOnly } from './bots-caller-gates'
import { dropUnreadBotRequests } from './orchestration/messaging/bot-request-outcome'
import { releaseHeldBotMail } from '../../../bots/bot-paused-mail'
import type { RpcContext } from '../core'
import { relinkBotSkills } from '../../../bots/bot-skill-projects'
import { linkBotOwnSkills } from '../../../bots/bot-own-skills'
import { botHomeFolder } from '../../../bots/bot-home'

export async function updateBot(params: BotUpdateParams, context: RpcContext) {
  if (params.updates.slackMirror !== undefined) {
    ownerOnly(context, 'Only the owner can change what posts to Slack')
  }
  const { members, addMembers: added, permissionMode } = params.updates
  if (members !== undefined || added !== undefined || permissionMode !== undefined) {
    ownerOnly(context, 'Only your owner changes your Who can ask or permissions, in Orca.')
  }
  const bot = await context.runtime.bots.update(params.botId, params.updates)
  if (params.updates.skillProjects !== undefined) {
    // Replies after the links and caches change, so a `/` menu opened next lists them.
    await relinkBotSkills(bot, context.runtime.listRepos())
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
  const removed = [...(removeMember ? [removeMember] : []), ...removeMembers]
  const changes = [
    ...removed.map((key) => ({ change: 'removed', key })),
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
