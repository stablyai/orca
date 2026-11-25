import { SHARE_SCOPED } from '../../../../shared/bots/bot-share-rpc-methods'
import { botShareScopedView } from '../../../bots/team-share/bot-share-scoped-view'
import { viewedAnswer } from '../../../bots/team-share/bot-share-connector-views'
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
    share: SHARE_SCOPED,
    params: null,
    handler: async (_params, context) =>
      viewedAnswer(
        await withHostCloudClient(context, (client) => client.linearState()),
        botShareScopedView(context)?.['bots.linear.state']
      )
  }),
  defineMethod({
    name: 'bots.linear.unlink',
    permission: 'accounts-admin',
    share: 'not-shared',
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
    share: 'not-shared',
    params: BotLinearMembers,
    handler: async ({ workspaceId, query }, context) =>
      withHostCloudClient(context, (client) => client.linearMembers(workspaceId, query))
  }),
  defineMethod({
    name: 'bots.linear.setDefaultBot',
    permission: 'accounts-admin',
    share: 'not-shared',
    params: BotLinearDefaultBot,
    handler: async ({ workspaceId, botId }, context) =>
      withHostCloudClient(context, (client) => client.setLinearDefaultBot(workspaceId, botId))
  })
]
