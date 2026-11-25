// bots.tools.setHostMcpServers: whether a bot's sessions also take its host's MCP server list. The
// choice lives on the bot's record, which the bot can't write (its home folder it can), and only the
// user sets it: a bot's own chat, runs and Look around are refused, so a bot never grants itself
// the user's servers and their sign-ins.
import { BotToolsSetHostMcpServers } from '../../../../shared/rpc-contract/bots-tools-params'
import { botHomeFolder } from '../../../bots/bot-home'
import { botOfCaller } from '../../../bots/bot-of-caller'
import { advanceBotToolsEpoch } from '../../../bots/bot-tools-revision'
import { assertMcpServersFeatureEnabled } from '../../../mcp-servers/mcp-servers-feature'
import { defineMethod, InvalidArgumentError } from '../core'
import { refuseFromLook, targetBot } from './bots-tools-target'

export const BOT_TOOLS_HOST_MCP_METHODS = [
  defineMethod({
    name: 'bots.tools.setHostMcpServers',
    permission: 'workspace',
    params: BotToolsSetHostMcpServers,
    handler: async (params, context) => {
      assertMcpServersFeatureEnabled()
      refuseFromLook(params, context)
      if (botOfCaller(context.runtime, params.callerSessionId, context.pairedDeviceId)) {
        throw new InvalidArgumentError(
          'A bot can’t change which servers it gets. Change it in Orca.'
        )
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
