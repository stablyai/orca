// `bots.github.*`: the host account's GitHub link and installs, as this host's own Orca account.
import {
  BotGitHubDefaultBot,
  BotGitHubUnlink,
  BotGitHubUsers
} from '../../../../shared/rpc-contract/bots-connector-setup-params'
import { defineMethod } from '../core'
import { withHostCloudClient } from './bots-slack'

export const BOT_GITHUB_METHODS = [
  defineMethod({
    name: 'bots.github.state',
    permission: 'accounts-admin',
    params: null,
    // What the owner sees is what the next hello says, so a finished install reaches GitHub at once.
    handler: async (_params, context) =>
      withHostCloudClient(context, (client) => {
        const { runtime } = context
        const read = () => client.githubState()
        const installations = runtime.connectorGitHubInstallations
        return installations
          ? installations.track(runtime.getConnectorCloud()?.signedInAccount() ?? null, read)
          : read()
      })
  }),
  defineMethod({
    name: 'bots.github.users',
    permission: 'accounts-admin',
    params: BotGitHubUsers,
    handler: async ({ query }, context) =>
      withHostCloudClient(context, (client) => client.githubUsers(query))
  }),
  defineMethod({
    name: 'bots.github.unlink',
    permission: 'accounts-admin',
    params: BotGitHubUnlink,
    handler: async ({ userId }, context) =>
      withHostCloudClient(context, (client) => client.unlinkGitHub(userId))
  }),
  defineMethod({
    name: 'bots.github.setDefaultBot',
    permission: 'accounts-admin',
    params: BotGitHubDefaultBot,
    handler: async ({ botId, userId }, context) =>
      withHostCloudClient(context, (client) => client.setGitHubDefaultBot(botId, userId))
  })
]
