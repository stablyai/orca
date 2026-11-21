// orca-fork: a team builder's `orca bot create --offer` is accepted here, the same way pressing Create
// bot on its card would be, and the new bot joins the lead's team group.
import type { Bot } from '../../../shared/bot-types'
import { botAddressArgument } from '../../../shared/bot-roster'
import { botFirstKickoff } from '../../../shared/bots/bot-import'
import { botMadeForWorkspacesKickoff } from '../../../shared/bots/bot-made-for-workspaces'
import { proposalCreateParams, type BotCreateOffer } from '../../../shared/bots/bot-proposal'
import type { BotCreateParams } from '../../../shared/rpc-contract/bots-params'
import { FORK_FEATURES } from '../../../shared/orca-fork/fork-features'
import { teamGroupName } from '../../../shared/orca-fork/agent-teams'
import { runtimeBotChats } from '../../bots/bot-chat-session'
import { runtimeBotGroups } from '../../bots/bot-group-runtime'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { AgentTeamStore, agentTeamFile } from './agent-team-store'

const GROUP_MEMBERS_MAX = 32

let store: AgentTeamStore | null = null
export function agentTeamStore(): AgentTeamStore {
  store ??= new AgentTeamStore(() => agentTeamFile(getProfileUserDataPath()))
  return store
}

/** The team room with the lead and `member` in it, made the first time; its name. */
async function joinTeamGroup(runtime: OrcaRuntimeService, lead: Bot, member: Bot): Promise<string> {
  const groups = runtimeBotGroups(runtime)
  const groupId = agentTeamStore().entry(lead.id).groupId
  const existing = groupId ? groups.store.listing().find((group) => group.id === groupId) : null
  if (existing) {
    const botIds = existing.members.map((entry) => entry.botId)
    if (!botIds.includes(member.id) && botIds.length < GROUP_MEMBERS_MAX) {
      await groups.update({
        groupId: existing.id,
        revision: existing.revision,
        botIds: [...botIds, member.id]
      })
    }
    return existing.name
  }
  const group = await groups.create({
    name: teamGroupName(lead.name),
    botIds: [lead.id, member.id]
  })
  agentTeamStore().setGroup(lead.id, group.id)
  return group.name
}

function teamKickoff(
  bot: Bot,
  lead: Bot,
  room: string | null,
  handOff: BotCreateParams['handOff']
): string {
  const lines = [
    handOff?.length ? botMadeForWorkspacesKickoff(handOff) : botFirstKickoff(bot),
    `${lead.name} created you for its team${room ? `; you share the bot group "${room}" with it` : ''}. Teammates hand work to each other without waiting for your owner: \`orca bot items add --for ${botAddressArgument(lead.name)} …\` files an item for ${lead.name}, and \`orca orchestration send --to bot:${botAddressArgument(lead.name)} --type handoff\` hands a job over.`
  ]
  return lines.join('\n\n')
}

/**
 * Creates the offered bot when its proposer may build a team and is under its daily cap; the line its
 * proposer sees instead of "your owner sees a card", or null to leave the card for the owner.
 */
export async function acceptTeamOffer(
  runtime: OrcaRuntimeService,
  lead: Bot,
  offer: BotCreateOffer
): Promise<string | null> {
  if (!FORK_FEATURES.agentTeams || !agentTeamStore().mayCreate(lead.id)) {
    return null
  }
  const fromOffer = { botId: lead.id, offerId: offer.offerId }
  const params = {
    ...proposalCreateParams(offer.proposal, lead.agent, { templatePackages: false, fromOffer }),
    fromOffer
  }
  const made = await runtime.bots.createFromOffer(params)
  if (made.existing || !made.bot) {
    return null
  }
  const bot = made.bot
  agentTeamStore().recordCreated(lead.id)
  console.info(`[orca-fork] team builder ${lead.name} created bot ${bot.name} (${bot.id})`)
  let room: string | null = null
  try {
    room = await joinTeamGroup(runtime, lead, bot)
  } catch (error) {
    console.warn('[orca-fork] team group update failed:', error)
  }
  runtimeBotChats(runtime)
    .sendToChat(bot.id, teamKickoff(bot, lead, room, params.handOff), 'bot-created')
    .catch((error: unknown) => console.warn('[orca-fork] team bot kickoff failed:', error))
  const address = botAddressArgument(bot.name)
  return `${bot.name} is created and starting now: you may build a team, so no owner approval was needed.${room ? ` It is in the bot group "${room}" with you.` : ''} Hand it work with \`orca bot items add --for ${address} …\` or \`orca orchestration send --to bot:${address} --type handoff\`.`
}
