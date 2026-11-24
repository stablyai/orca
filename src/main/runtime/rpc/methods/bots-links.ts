// `bots.links.*`: the host account's linked Slack, GitHub and Linear people, as its own Orca account.
import { BotLinkedAccount } from '../../../../shared/rpc-contract/bots-connector-setup-params'
import { defineMethod } from '../core'
import { withHostCloudClient } from './bots-slack'

export const BOT_LINKS_LIST = defineMethod({
  name: 'bots.links.list',
  permission: 'accounts-admin',
  params: null,
  handler: async (_params, context) => withHostCloudClient(context, (client) => client.links.list())
})

export const BOT_LINKS_UNLINK = defineMethod({
  name: 'bots.links.unlink',
  permission: 'accounts-admin',
  params: BotLinkedAccount,
  handler: async (link, context) =>
    withHostCloudClient(context, (client) => client.links.unlink(link))
})

export const BOT_LINKS_METHODS = [BOT_LINKS_LIST, BOT_LINKS_UNLINK]
