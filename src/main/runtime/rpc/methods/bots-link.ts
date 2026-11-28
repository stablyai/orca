// `orca bot link`: what a bot gives its owner for "take me to X". Switching a window here would only
// change this computer's screen, which the person asking from Slack, a phone or a paired computer
// does not see; the link opens in whichever Orca it is clicked in.
import { formatBotDeepLink, parseBotDeepLink } from '../../../../shared/bot-deep-link'
import {
  isOrcaSessionId,
  parseOrcaSessionAddress
} from '../../../../shared/agent-session/identity/orca-session-address'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { BotLink, type BotLinkResult } from '../../../../shared/rpc-contract/bots-link-params'
import { WORKSPACE_SELECTOR_NOT_FOUND } from '../../workspaces/catalog/workspace-selector-candidates'
import { defineMethod, InvalidArgumentError } from '../core'
import { botOf } from './bots-work'

export const BOT_LINK_METHODS = [
  defineMethod({
    name: 'bots.link',
    permission: 'workspace',
    params: BotLink,
    handler: async (params, context): Promise<BotLinkResult> => {
      context.runtime.bots.assertEnabled()
      const bot = botOf(params, context)
      const agent = parseOrcaSessionAddress(params.agentSessionId) ?? params.agentSessionId
      if (agent !== undefined && !isOrcaSessionId(agent)) {
        throw new InvalidArgumentError(
          '--agent takes an orca_session_id from `orca worktree ps` or `orca agent list`.'
        )
      }
      const workspace = await context.runtime
        .showManagedWorktree(params.worktree, LOCAL_EXECUTION_HOST_ID, { matchFolders: true })
        .catch((error: unknown) => {
          if (error instanceof Error && error.message === WORKSPACE_SELECTOR_NOT_FOUND) {
            throw new InvalidArgumentError('Choose a workspace on the computer that runs the bot.')
          }
          throw error
        })
      const link = formatBotDeepLink({
        botId: bot.id,
        workspace: { worktreeId: workspace.id, ...(agent ? { agentSessionId: agent } : {}) }
      })
      if (!parseBotDeepLink(link)) {
        throw new InvalidArgumentError(
          'This workspace has an ID that cannot be used in an Orca link.'
        )
      }
      return { link, workspaceName: workspace.displayName }
    }
  })
]
