// `orca bot link`: what a bot gives its owner for "take me to X". Switching a window here would only
// change this computer's screen, which the person asking from Slack, a phone or a paired computer
// does not see; the link opens in whichever Orca it is clicked in.
import { formatBotDeepLink, isBotDeepLinkSessionId } from '../../../../shared/bot-deep-link'
import { BotLink, type BotLinkResult } from '../../../../shared/rpc-contract/bots-link-params'
import { defineMethod, InvalidArgumentError } from '../core'
import { botOf } from './bots-work'

const SESSION_HANDLE_PREFIX = 'orca_session_id:'

export const BOT_LINK_METHODS = [
  defineMethod({
    name: 'bots.link',
    permission: 'workspace',
    params: BotLink,
    handler: async (params, context): Promise<BotLinkResult> => {
      context.runtime.bots.assertEnabled()
      const bot = botOf(params, context)
      // The link reaches the workspace through the bot's computer, so only this computer's resolve.
      const worktree = await context.runtime.showManagedWorktree(params.worktree)
      const agent = params.agentSessionId?.startsWith(SESSION_HANDLE_PREFIX)
        ? params.agentSessionId.slice(SESSION_HANDLE_PREFIX.length)
        : params.agentSessionId
      if (agent !== undefined && !isBotDeepLinkSessionId(agent)) {
        throw new InvalidArgumentError(
          '--agent takes an orca_session_id from `orca worktree ps` or `orca agent list`.'
        )
      }
      return {
        link: formatBotDeepLink({
          botId: bot.id,
          workspace: { worktreeId: worktree.id, ...(agent ? { agentSessionId: agent } : {}) }
        }),
        workspaceName: worktree.displayName,
        botName: bot.name
      }
    }
  })
]
