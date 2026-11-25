// bots.tools.setHostMcpServers: whether a bot's sessions also take its host's MCP server list. The
// choice lives on the bot's record, which the bot can't write (its home folder it can), and only a
// person sets it from Orca or a phone: the transport names the caller, and any agent's `orca` CLI
// is refused whatever it claims, so a bot never grants itself the user's servers and sign-ins.
import { BotToolsSetHostMcpServers } from '../../../../shared/rpc-contract/bots-tools-params'
import { botHomeFolder } from '../../../bots/bot-home'
import { advanceBotToolsEpoch } from '../../../bots/bot-tools-revision'
import { assertMcpServersFeatureEnabled } from '../../../mcp-servers/mcp-servers-feature'
import { defineMethod, InvalidArgumentError } from '../core'
import { isAgentRpcCaller } from '../callers/rpc-caller-identity'
import { targetBot } from './bots-tools-target'

export const BOT_TOOLS_HOST_MCP_METHODS = [
  defineMethod({
    name: 'bots.tools.setHostMcpServers',
    permission: 'workspace',
    params: BotToolsSetHostMcpServers,
    handler: async (params, context) => {
      assertMcpServersFeatureEnabled()
      if (!context.caller || isAgentRpcCaller(context.caller)) {
        throw new InvalidArgumentError('Change which servers a bot gets in Orca.')
      }
      let changed = false
      const bot = await context.runtime.bots.update(targetBot(params, context).id, (current) => {
        changed = (current.hostMcpServers === true) !== params.enabled
        return { hostMcpServers: params.enabled ? true : undefined }
      })
      // A tools change: the bot's running chats relaunch with it on their next turn.
      if (changed) {
        advanceBotToolsEpoch(botHomeFolder(bot))
      }
      return { hostMcpServers: bot.hostMcpServers === true }
    }
  })
]
