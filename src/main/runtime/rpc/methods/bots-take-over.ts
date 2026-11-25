// `bots.takeOver`: the owner handed a bot a workspace (Hand to bot…), which Orca already moved under
// the bot's home. Orca tells the bot in its Home when the bot was just made for it, else in a new chat.
// A turn the chat refuses is an error, so the owner's client puts the workspace back and can retry.
import { OWNER_ACTS_FOR } from '../../../../shared/bots/bot-acts-for'
import { botTakeOverKickoff, type BotTakeOver } from '../../../../shared/bots/bot-take-over'
import { tookOverLabel, type TookOverNotice } from '../../../../shared/native-chat/took-over-notice'
import { BOT_HANDED_PAIRED_WORKSPACES_MAX, type Bot } from '../../../../shared/bot-types'
import { BotTakeOverParams } from '../../../../shared/rpc-contract/bots-params'
import {
  closeBotSession,
  requireStructuredHost,
  runtimeBotChats,
  startBotSession
} from '../../../bots/bot-chat-session'
import { chatThatTookIt } from '../../../bots/bot-automation-sessions'
import { forgetPairedReads } from '../../../bots/bot-paired-handed-agents'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { ownerOnly } from './bots-caller-gates'
import { defineMethod, InvalidArgumentError } from '../core'

export const BOT_TAKE_OVER_METHOD = defineMethod({
  name: 'bots.takeOver',
  permission: 'workspace',
  share: 'not-shared',
  params: BotTakeOverParams,
  handler: async ({ botId, chat, takeOver }, context) => {
    const { runtime } = context
    runtime.bots.assertEnabled()
    ownerOnly(context, 'Only your owner hands you a workspace, in Orca.')
    const bot = runtime.bots.list().find((entry) => entry.id === botId)
    if (!bot) {
      throw new InvalidArgumentError('bot_not_found')
    }
    const chats = runtimeBotChats(runtime)
    const text = botTakeOverKickoff(takeOver)
    const tookOver = (home: boolean): { kind: 'took-over'; tookOver: TookOverNotice } => ({
      kind: 'took-over',
      tookOver: {
        workspace: takeOver.workspace.name,
        ...(takeOver.goal ? { goal: takeOver.goal } : {}),
        ...(home ? { home: true as const } : {})
      }
    })
    const refused = (error: unknown): InvalidArgumentError =>
      new InvalidArgumentError(
        `${bot.name} couldn't take ${takeOver.workspace.name}: ${error instanceof Error ? error.message : String(error)}`
      )
    let sessionId: string
    if (chat === 'home') {
      try {
        sessionId = chatThatTookIt(await chats.sendToChat(bot.id, text, tookOver(true))).sessionId
      } catch (error) {
        throw refused(error)
      }
    } else {
      sessionId = await startBotSession(runtime, bot, {
        actsFor: { actsFor: [...OWNER_ACTS_FOR] }
      })
      try {
        // Named for the hand-over, not from Orca's turn, which is the bot's context.
        await (
          await requireStructuredHost(runtime)
        )
          .setUserConversationName(sessionId, tookOverLabel(takeOver.workspace.name), 'rename')
          .catch((error: unknown) => console.warn('[bots] could not name a hand-over chat', error))
        chatThatTookIt(
          await chats.sendToSession(bot.id, sessionId, text, undefined, tookOver(false))
        )
      } catch (error) {
        // No empty chat stays behind for a hand-over that did not happen.
        await closeBotSession(runtime, sessionId).catch((closeError: unknown) =>
          console.warn('[bots] could not close a refused hand-over chat', closeError)
        )
        throw refused(error)
      }
    }
    await rememberPairedWorkspace(runtime, bot, takeOver.workspace)
    return { sessionId }
  }
})

/** A paired computer's workspace keeps its link to the bot in that computer's store; the bot keeps
 *  where to ask, so its Activity can show the agents there. */
async function rememberPairedWorkspace(
  runtime: Pick<OrcaRuntimeService, 'bots' | 'callOrchestrationWorkerServer'>,
  bot: Bot,
  workspace: BotTakeOver['workspace']
): Promise<void> {
  const { environment } = workspace
  if (!environment) {
    return
  }
  // An answer read before this hand-over still shows the workspace's old parent.
  forgetPairedReads(runtime, environment)
  await runtime.bots
    .update(bot.id, (saved) => {
      const others = (saved.handedPairedWorkspaces ?? []).filter(
        (entry) => entry.environmentId !== environment || entry.worktreeId !== workspace.id
      )
      return {
        handedPairedWorkspaces: [
          ...others.slice(-(BOT_HANDED_PAIRED_WORKSPACES_MAX - 1)),
          { environmentId: environment, worktreeId: workspace.id, at: Date.now() }
        ]
      }
    })
    .catch((error: unknown) => console.warn('[bots] could not record a paired hand-over', error))
}
