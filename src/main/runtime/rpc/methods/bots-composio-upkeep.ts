// Composio's events on the desktop that hosts webhooks: the events hook's router, the Reconnect card
// for an expired sign-in, and the upkeep pass.
import { composioUserOfBot } from '../../../../shared/composio/composio-apps'
import { composioAppName } from '../../../../shared/composio/composio-curated-apps'
import { composioUserOfAccount } from '../../../composio/composio-api-events'
import { composioCallRouter, ComposioUpkeep } from '../../../composio/composio-upkeep'
import type { WebhookHostService } from '../../../webhooks/webhook-host-service'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { instanceOf } from './bots-composio'

export function installComposioUpkeep(
  runtime: OrcaRuntimeService,
  webhooks: WebhookHostService
): ComposioUpkeep {
  webhooks.setCallRouter(
    composioCallRouter({
      automations: () => webhooks.automations(),
      expired: (accountId, app) => postReconnectCard(runtime, accountId, app)
    })
  )
  const upkeep = new ComposioUpkeep(async () => {
    const { bots, events } = instanceOf(runtime)
    await bots.drainCleanup()
    await events.reconcile(runtime.bots.list().map((bot) => bot.id))
  })
  upkeep.start()
  return upkeep
}

// Sign-ins whose expiry the bot's chat already shows; Composio may send one expiry more than once.
const noticed = new Set<string>()

async function postReconnectCard(
  runtime: OrcaRuntimeService,
  accountId: string,
  app: string
): Promise<void> {
  if (noticed.has(accountId)) {
    return
  }
  const { bots, setup } = instanceOf(runtime)
  const user = await bots.withKey((api) => composioUserOfAccount(api, accountId))
  const bot = runtime.bots.list().find((entry) => composioUserOfBot(entry.id) === user)
  if (bot) {
    setup.signInExpired(bot.id, { slug: app, name: composioAppName(app) })
  }
  noticed.add(accountId)
}
