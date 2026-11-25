// `bots.links.*`: the host account's linked Slack, GitHub and Linear people, as its own Orca account.
import { BotLinkedAccount } from '../../../../shared/rpc-contract/bots-connector-setup-params'
import type { BotsCloudClient } from '../../../connector-cloud/bots-cloud-client'
import { clearWorkspaceLogin } from '../../../linear/accounts/linear-login-store'
import { defineMethod } from '../core'
import { withHostCloudClient } from './bots-slack'

/** A Linear workspace's login came with its link (bots.linear.unlink); it goes with the last one. */
async function forgetLinearLoginOnceUnlinked(
  client: BotsCloudClient,
  workspaceId: string
): Promise<void> {
  const left = await client.links.list()
  const stillLinked =
    !left.ok ||
    left.value.links.some((other) => other.source === 'linear' && other.workspaceId === workspaceId)
  if (!stillLinked) {
    await clearWorkspaceLogin(workspaceId)
  }
}

export const BOT_LINKS_LIST = defineMethod({
  name: 'bots.links.list',
  permission: 'accounts-admin',
  share: 'not-shared',
  params: null,
  handler: async (_params, context) => withHostCloudClient(context, (client) => client.links.list())
})

export const BOT_LINKS_UNLINK = defineMethod({
  name: 'bots.links.unlink',
  permission: 'accounts-admin',
  share: 'not-shared',
  params: BotLinkedAccount,
  handler: async (link, context) =>
    withHostCloudClient(context, async (client) => {
      const unlinked = await client.links.unlink(link)
      if (unlinked.ok && link.source === 'linear') {
        await forgetLinearLoginOnceUnlinked(client, link.workspaceId)
      }
      return unlinked
    })
})

export const BOT_LINKS_METHODS = [BOT_LINKS_LIST, BOT_LINKS_UNLINK]
