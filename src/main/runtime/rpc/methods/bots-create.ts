// `bots.create`: the owner's New bot, in Orca (desktop or phone). A bot only proposes one
// (`bots.createOffer`); creating from its card records the new bot against that card.
import { BotCreate } from '../../../../shared/rpc-contract/bots-params'
import { botFirstKickoff } from '../../../../shared/bots/bot-import'
import { botMadeForWorkspacesKickoff } from '../../../../shared/bots/bot-made-for-workspaces'
import { runtimeBotChats } from '../../../bots/bot-chat-session'
import { ownerOnly } from './bots-caller-gates'
import { createBotFromShare } from '../../../bots/sharing/bot-share-create'
import { botTemplateCreation, createBotFromTemplate } from '../../../bots/bot-template-create'
import { botShareCreateDeps } from './bots-share-create-deps'
import { defineMethod, InvalidArgumentError } from '../core'

export const BOT_CREATE_METHOD = defineMethod({
  name: 'bots.create',
  permission: 'workspace',
  params: BotCreate,
  handler: async (
    { handOff, takingOver, fromOffer, fromShare, fromTemplate, ...params },
    context
  ) => {
    const { runtime } = context
    runtime.bots.assertEnabled()
    // A bot proposes new bots (`bot create --offer`); only its owner creates one, in Orca.
    ownerOnly(
      context,
      'A bot can’t create a bot. Propose one with `orca bot create --offer`; your owner creates it from the card.'
    )
    let bot
    if (fromShare) {
      bot = await createBotFromShare(botShareCreateDeps(runtime), { ...params, fromShare })
    } else if (fromOffer) {
      if (!runtime.bots.list().some((entry) => entry.id === fromOffer.botId)) {
        throw new InvalidArgumentError('The bot that proposed this bot is gone.')
      }
      // A template offer is still made once per card, its package installed in that same step.
      const template = fromTemplate
        ? botTemplateCreation(botShareCreateDeps(runtime), { ...params, fromTemplate })
        : null
      const made = await runtime.bots.createFromOffer(
        { ...(template?.params ?? params), fromOffer },
        template?.origin,
        template?.finish
      )
      if (made.existing) {
        // Already created from this card (another window, or Create and Edit at once): that bot,
        // with no second first turn.
        if (!made.bot) {
          throw new InvalidArgumentError('A bot was already created from that card, then deleted.')
        }
        return { bot: made.bot }
      }
      bot = made.bot!
    } else if (fromTemplate) {
      bot = await createBotFromTemplate(botShareCreateDeps(runtime), { ...params, fromTemplate })
    } else {
      bot = await runtime.bots.create(params)
    }
    // Made in Hand to bot: its first turn is the hand-over, once the workspace is under its home.
    if (takingOver) {
      return { bot }
    }
    // The bot speaks first: its first-run rules turn this into a greeting. Made for workspaces, it then
    // offers to take them over; made from another app's bot, its first turn brings that bot over; made
    // from a link, it says whose; made from a template, it says which.
    try {
      await runtimeBotChats(runtime).sendToChat(
        bot.id,
        handOff ? botMadeForWorkspacesKickoff(handOff) : botFirstKickoff(bot),
        'bot-created'
      )
      return { bot, kickoff: 'starting' as const }
    } catch {
      return { bot, kickoff: 'failed' as const }
    }
  }
})
