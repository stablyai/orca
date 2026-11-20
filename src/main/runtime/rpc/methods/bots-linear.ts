// `bots.linear.*`: the host account's Linear links, as this host's own Orca account.
import {
  BotLinearDefaultBot,
  BotLinearMembers,
  BotLinearWorkspace
} from '../../../../shared/rpc-contract/bots-connector-setup-params'
import { clearWorkspaceLogin } from '../../../linear/accounts/linear-login-store'
import { defineMethod } from '../core'
import { withHostCloudClient } from './bots-slack'

export const BOT_LINEAR_METHODS = [
  defineMethod({
    name: 'bots.linear.state',
    permission: 'accounts-admin',
    params: null,
    handler: async (_params, context) =>
      withHostCloudClient(context, (client) => client.linearState())
  }),
  defineMethod({
    name: 'bots.linear.unlink',
    permission: 'accounts-admin',
    params: BotLinearWorkspace,
    handler: async ({ workspaceId }, context) =>
      withHostCloudClient(context, async (client) => {
        const unlinked = await client.unlinkLinear(workspaceId)
        // The login came with the link; it goes with it.
        if (unlinked.ok) {
          await clearWorkspaceLogin(workspaceId)
        }
        return unlinked
      })
  }),
  defineMethod({
    name: 'bots.linear.members',
    permission: 'accounts-admin',
    params: BotLinearMembers,
    handler: async ({ workspaceId, query }, context) =>
      withHostCloudClient(context, (client) => client.linearMembers(workspaceId, query))
  }),
  defineMethod({
    name: 'bots.linear.setDefaultBot',
    permission: 'accounts-admin',
    params: BotLinearDefaultBot,
    handler: async ({ workspaceId, botId }, context) =>
      withHostCloudClient(context, (client) => client.setLinearDefaultBot(workspaceId, botId))
  })
]
