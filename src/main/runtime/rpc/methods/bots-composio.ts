// `bots.composio.*`: a bot's Composio apps. Orca reads the app list and the bot's sign-ins with the
// owner's key on the bot's host; the key itself is set only from the owner's Orca.
import { randomUUID } from 'node:crypto'
import { composioSetupCardBody } from '../../../../shared/composio/composio-setup-card'
import { composioAppName } from '../../../../shared/composio/composio-curated-apps'
import {
  ComposioApp,
  ComposioApps,
  ComposioBot,
  ComposioConnect,
  ComposioDisconnect,
  ComposioKeyDeclined,
  ComposioRemoveKey,
  ComposioSetKey,
  ComposioSetupCard,
  ComposioStartSetup
} from '../../../../shared/rpc-contract/bots-composio-params'
import { botOfCaller } from '../../../bots/bot-of-caller'
import { runtimeBotChats } from '../../../bots/bot-chat-session'
import { noteInChat, writeInChat } from '../../../bots/bot-chat-status-line'
import { LOOK_AROUND_REFUSAL } from '../../../bots/bot-look-around-policy'
import { ComposioBots } from '../../../composio/composio-bots'
import {
  clearComposioKey,
  readComposioKey,
  saveComposioKey
} from '../../../composio/composio-key-store'
import { ComposioSetup } from '../../../composio/composio-setup'
import { ComposioEvents } from '../../../composio/composio-events'
import { createComposioIngress } from './bots-composio-ingress'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { InvalidArgumentError, notShared, defineMethod, type RpcContext } from '../core'
import { ownerOnly } from './bots-caller-gates'
import { botToolsHome } from './bots-tools'

const instances = new WeakMap<
  OrcaRuntimeService,
  { bots: ComposioBots; setup: ComposioSetup; events: ComposioEvents }
>()

export function webhooksOf(runtime: OrcaRuntimeService) {
  const service = runtime.getWebhooks()
  if (!service) {
    throw new InvalidArgumentError('Webhooks aren’t available on this computer.')
  }
  return service
}

/** This runtime's Composio pieces, made on first use. */
export function instanceOf(runtime: OrcaRuntimeService) {
  let instance = instances.get(runtime)
  if (!instance) {
    const bots: ComposioBots = new ComposioBots({
      keys: { read: readComposioKey, save: saveComposioKey, clear: clearComposioKey },
      cliOf: async (botId) => botToolsHome(runtime, botOf(runtime, botId)),
      botIds: () => runtime.bots.list().map((bot) => bot.id),
      botExists: (botId) => runtime.bots.list().some((bot) => bot.id === botId),
      nameOf: (botId) => runtime.bots.list().find((bot) => bot.id === botId)?.name ?? botId,
      onChange: () => runtime.notifyBotsChanged({ kinds: ['settings'] }),
      onProjectRekeyed: (from, to) => events.rekeyed(from, to),
      onConnectEnded: (botId, app, connection, card) => {
        if (card) {
          void setup
            .connectEnded(botId, { slug: app, name: card.name }, connection, card.reason)
            .catch((error: unknown) => console.warn('[composio] setup card update failed', error))
        }
      }
    })
    const setup = new ComposioSetup(bots, {
      botName: (botId) => botOf(runtime, botId).name,
      tellBot: (botId, line) => runtimeBotChats(runtime).sendToChat(botId, line, 'card-answer'),
      chatOf: (botId) => botOf(runtime, botId).chatSessionId ?? undefined,
      write: (sessionId, item) =>
        typeof item === 'string'
          ? noteInChat(sessionId, item)
          : writeInChat(sessionId, composioSetupCardBody(item), 'composio-setup')
    })
    const events = new ComposioEvents(bots, {
      botOf: (hookId) => {
        try {
          return webhooksOf(runtime).automationOf(hookId).bot?.botId ?? null
        } catch {
          return null
        }
      },
      // Status runs on every bots change, so it reads the address without revealing the key.
      base: async (hookId) => (await webhooksOf(runtime).card(hookId)).url,
      url: async (hookId) => (await webhooksOf(runtime).reveal(hookId)).url,
      setSecret: async (hookId, secret) => {
        await webhooksOf(runtime).setSecret({
          hookId,
          operationId: randomUUID(),
          adapter: 'standard',
          secret
        })
      },
      createIngress: (botId) => createComposioIngress(runtime, botOf(runtime, botId)),
      automations: () => webhooksOf(runtime).automations(),
      deleteAutomation: async (id) => {
        await runtime.deleteAutomation(id)
      }
    })
    instance = { bots, setup, events }
    instances.set(runtime, instance)
    // Bots deleted while the key was unusable, from an earlier run.
    void bots.drainCleanup()
  }
  return instance
}

/** This runtime's Composio apps, made on first use. */
export function composioBotsOf(runtime: OrcaRuntimeService): ComposioBots {
  return instanceOf(runtime).bots
}

function botOf(runtime: OrcaRuntimeService, botId: string) {
  const bot = runtime.bots.list().find((entry) => entry.id === botId)
  if (!bot) {
    throw new InvalidArgumentError('bot_not_found')
  }
  return bot
}

export function composio(context: RpcContext, botId?: string): ComposioBots {
  context.runtime.bots.assertEnabled()
  if (botId) {
    botOf(context.runtime, botId)
  }
  return composioBotsOf(context.runtime)
}

/** The bot a setup card is for: the chat the command ran from, or the bot named. */
export function setupBot(
  params: { callerSessionId?: string; botId?: string },
  context: RpcContext
) {
  const { runtime } = context
  runtime.bots.assertEnabled()
  const bot = botOfCaller(runtime, params.callerSessionId, context.pairedDeviceId)
  if (bot) {
    if (params.callerSessionId && runtime.lookAround.botOfLook(params.callerSessionId)) {
      throw new InvalidArgumentError(LOOK_AROUND_REFUSAL)
    }
    return bot
  }
  if (!params.botId) {
    throw new InvalidArgumentError("Run this from a bot's chat, or name the bot.")
  }
  return botOf(runtime, params.botId)
}

export const BOT_COMPOSIO_METHODS = [
  defineMethod({
    name: 'bots.composio.status',
    ...notShared('workspace'),
    params: ComposioBot,
    handler: ({ botId }, context) => composio(context, botId).status(botId)
  }),
  defineMethod({
    name: 'bots.composio.setKey',
    ...notShared('workspace'),
    params: ComposioSetKey,
    handler: async ({ key, botId, app }, context) => {
      // The key goes from the owner's dialog to this host; a bot never handles it.
      ownerOnly(context, 'Your owner adds the Composio key in Orca.')
      const bots = composio(context, botId)
      // In the events lane, so no events setup or upkeep is part way through on the old key.
      await instanceOf(context.runtime).events.exclusive(() => bots.setKey(key))
      if (botId) {
        await instanceOf(context.runtime).setup.keyAdded(botId, app)
      }
      return { key: await composioBotsOf(context.runtime).keyState() }
    }
  }),
  defineMethod({
    name: 'bots.composio.key',
    ...notShared('workspace'),
    params: null,
    handler: async (_params, context) => ({
      ...(await composio(context).key()),
      events: await instanceOf(context.runtime).events.eventsPlace()
    })
  }),
  defineMethod({
    name: 'bots.composio.removeKey',
    ...notShared('workspace'),
    params: ComposioRemoveKey,
    handler: async (params, context) => {
      ownerOnly(context, 'Your owner removes the Composio key in Orca.')
      const bots = composio(context)
      const { events } = instanceOf(context.runtime)
      await events.exclusive(async () => {
        if (params?.alsoEvents) {
          // While the key still works.
          await events.turnOffNow(context.runtime.bots.list().map((bot) => bot.id))
        }
        await bots.removeKey()
      })
      return { key: await composioBotsOf(context.runtime).keyState() }
    }
  }),
  defineMethod({
    name: 'bots.composio.checkLimit',
    ...notShared('workspace'),
    params: null,
    handler: async (_params, context) => {
      await composio(context).checkLimit()
      return { limited: false }
    }
  }),
  defineMethod({
    name: 'bots.composio.apps',
    ...notShared('workspace'),
    params: ComposioApps,
    handler: ({ botId, search, cursor }, context) =>
      composio(context, botId).apps({ search, cursor })
  }),
  defineMethod({
    name: 'bots.composio.app',
    ...notShared('workspace'),
    params: ComposioApp,
    handler: ({ botId, app }, context) => composio(context, botId).app(app)
  }),
  defineMethod({
    name: 'bots.composio.connections',
    ...notShared('workspace'),
    params: ComposioBot,
    handler: ({ botId }, context) => composio(context, botId).connections(botId)
  }),
  defineMethod({
    name: 'bots.composio.connect',
    ...notShared('workspace'),
    params: ComposioConnect,
    handler: ({ botId, app, card }, context) =>
      composio(context, botId).connect(botId, app, card ?? null)
  }),
  defineMethod({
    name: 'bots.composio.cancelConnect',
    ...notShared('workspace'),
    params: ComposioApp,
    handler: ({ botId, app }, context) => {
      composio(context, botId).cancelConnect(botId, app)
      return { cancelled: app }
    }
  }),
  defineMethod({
    name: 'bots.composio.disconnect',
    ...notShared('workspace'),
    params: ComposioDisconnect,
    handler: async ({ botId, accountId }, context) => {
      await composio(context, botId).disconnect(botId, accountId)
      return { disconnected: accountId }
    }
  }),
  defineMethod({
    name: 'bots.composio.add',
    ...notShared('workspace'),
    params: ComposioBot,
    handler: async ({ botId }, context) => {
      await composio(context, botId).ensureTool(botId)
      return { added: true }
    }
  }),
  defineMethod({
    name: 'bots.composio.remove',
    ...notShared('workspace'),
    params: ComposioBot,
    handler: async ({ botId }, context) => {
      await composio(context, botId).removeFromBot(botId)
      return { removed: true }
    }
  }),
  defineMethod({
    name: 'bots.composio.startSetup',
    ...notShared('workspace'),
    params: ComposioStartSetup,
    handler: async ({ botId, from, app }, context) => {
      ownerOnly(context, 'Your owner starts Composio setup from Orca.')
      composio(context, botId)
      await instanceOf(context.runtime).setup.start(botId, from, app)
      return { started: true }
    }
  }),
  defineMethod({
    name: 'bots.composio.setup',
    ...notShared('workspace'),
    params: ComposioSetupCard,
    handler: async (params, context) => {
      const bot = setupBot(params, context)
      composio(context)
      const app = params.app
        ? { slug: params.app, name: params.name ?? composioAppName(params.app) }
        : undefined
      const { card, message } = await instanceOf(context.runtime).setup.card(bot.id, app)
      return { card: card?.card ?? null, message }
    }
  }),
  defineMethod({
    name: 'bots.composio.declineKey',
    ...notShared('workspace'),
    params: ComposioKeyDeclined,
    handler: async ({ botId }, context) => {
      ownerOnly(context, 'Only your owner answers setup cards, in Orca.')
      composio(context, botId)
      await instanceOf(context.runtime).setup.keyDeclined(botId)
      return { declined: true }
    }
  })
]
