// Each bot's Composio apps on its host. A bot's sign-ins belong to its own Composio user, and its
// Composio tool is that user's session MCP server, reached through Orca's relay, which adds the key.
import {
  composioUserOfBot,
  type ComposioApp,
  type ComposioAppPage,
  type ComposioConnection,
  type ComposioConnections,
  type ComposioKey,
  type ComposioKeyState,
  type ComposioStatus
} from '../../shared/composio/composio-apps'
import type { BotToolsHome } from '../bots/bot-tools-host'
import { removeBotTool } from '../bots/bot-tools-removal'
import { readBotToolServers } from '../bots/bot-tools-file'
import { ComposioApi } from './composio-api'
import { ComposioCleanup, composioCleanupFile, composioProjectOf } from './composio-cleanup'
import { ComposioConnectWaits, type ComposioConnectCard } from './composio-connect-waits'
import { ComposioKeyHealth } from './composio-key-health'
import { composioServerOf, ensureComposioTool, sessionIdOf } from './composio-bot-tool'
import { ComposioAppNames } from './composio-app-names'
import {
  appsWithOwnerSetUp,
  appWithOwnerSetUp,
  linkWithOwnerSetUp
} from './composio-owner-auth-configs'

export { composioServerOf, sessionIdOf } from './composio-bot-tool'

export type ComposioKeyStore = {
  read: () => string | null
  save: (key: string) => void
  clear: () => void
}

export type ComposioBotsDeps = {
  keys: ComposioKeyStore
  /** The agent CLI the bot's tools are kept for; throws for a bot without tools. */
  cliOf: (botId: string) => Promise<BotToolsHome>
  /** This host's bots that can have tools. */
  botIds: () => readonly string[]
  /** Something a client shows changed: the key, a bot's tool or a sign-in. */
  onChange: () => void
  /** The bot is still on this host, so its sign-ins aren't to be cleaned up. */
  botExists?: (botId: string) => boolean
  /** The bot's name, for an error that names it. */
  nameOf?: (botId: string) => string
  /** A regenerated key reached the same project: records under `from` are now `to`'s. */
  onProjectRekeyed?: (from: string, to: string) => void
  /** The deleted bots still to clean up at Composio. */
  cleanup?: ComposioCleanup
  /** A Connect this host waited on ended; `card` when a chat setup card started it. */
  onConnectEnded?: (
    botId: string,
    app: string,
    connection: ComposioConnection | null,
    card: ComposioConnectCard
  ) => void
  api?: (key: string) => ComposioApi
  now?: () => number
}

export class ComposioBots {
  private readonly health = new ComposioKeyHealth(() => this.deps.onChange())
  private readonly cleanup: ComposioCleanup
  private readonly waits: ComposioConnectWaits
  private readonly names = new ComposioAppNames()
  private readonly ensuring = new Map<string, Promise<string>>()
  private readonly api: (key: string) => ComposioApi
  private readonly now: () => number

  constructor(private readonly deps: ComposioBotsDeps) {
    this.api = deps.api ?? ((key) => new ComposioApi(key))
    this.cleanup = deps.cleanup ?? new ComposioCleanup(composioCleanupFile())
    this.now = deps.now ?? Date.now
    this.waits = new ComposioConnectWaits({
      read: (accountId) => this.withKey((api) => api.connection(accountId)),
      onChange: () => this.deps.onChange(),
      ended: async (botId, app, connection, card) => {
        if (connection) {
          await this.dropOtherSignIns(botId, connection)
        }
        this.deps.onChange()
        this.deps.onConnectEnded?.(botId, app, connection, card)
      },
      now: this.now
    })
  }

  /** The saved key's project, by its fingerprint; null without a key. */
  project(): string | null {
    const key = this.deps.keys.read()
    return key ? composioProjectOf(key) : null
  }

  keyState(): ComposioKeyState {
    let key: string | null
    try {
      key = this.deps.keys.read()
    } catch {
      return 'unreadable'
    }
    return key === null ? 'none' : this.health.rejected ? 'rejected' : 'ok'
  }

  key(): ComposioKey {
    return { key: this.keyState(), hint: this.deps.keys.read()?.slice(-4) ?? null }
  }

  async status(botId: string): Promise<ComposioStatus> {
    const cli = await this.deps.cliOf(botId)
    return {
      key: this.keyState(),
      limit: this.health.limit,
      added: composioServerOf(await readBotToolServers(cli.folder)) !== undefined
    }
  }

  /** Checks the key by reading one app and saves it; the relay sends it from the next call on. A key
   *  from another Composio project has none of the old sessions, so those bots get new ones. */
  async setKey(key: string): Promise<void> {
    const trimmed = key.trim()
    if (!trimmed) {
      throw new Error('Paste your Composio key.')
    }
    const api = this.api(trimmed)
    await api.apps({ limit: 1 })
    const previous = this.project()
    // A regenerated key reaches the old key's sessions: the same project, so its records carry over.
    const continued = previous !== null && (await this.reachesBotSession(api))
    this.deps.keys.save(trimmed)
    this.health.reset()
    if (previous && continued) {
      this.cleanup.relabel(previous, composioProjectOf(trimmed))
      this.deps.onProjectRekeyed?.(previous, composioProjectOf(trimmed))
    }
    await this.eachBotWithTool((botId) => this.ensureTool(botId))
    this.deps.onChange()
    void this.drainCleanup()
  }

  /** Takes the Composio tool off every bot, then forgets the key; sign-ins stay at Composio. A bot
   *  whose tool stays keeps the key, since its tool still carries it. */
  async removeKey(): Promise<void> {
    const failed = await this.eachBotWithTool((botId) => this.removeFromBot(botId))
    if (failed.length > 0) {
      const names = failed.map((botId) => this.deps.nameOf?.(botId) ?? botId).join(', ')
      throw new Error(
        `Orca couldn’t take the Composio tool off ${names}, so the key is kept. Try again.`
      )
    }
    this.deps.keys.clear()
    this.health.reset()
    this.deps.onChange()
  }

  /** Runs `work` for each bot with a Composio tool; the bots it failed for. */
  private async eachBotWithTool(work: (botId: string) => Promise<unknown>): Promise<string[]> {
    const failed: string[] = []
    for (const botId of this.deps.botIds()) {
      try {
        const cli = await this.deps.cliOf(botId)
        if (composioServerOf(await readBotToolServers(cli.folder))) {
          await work(botId)
        }
      } catch (error) {
        console.warn('[composio] updating a bot’s Composio tool failed', error)
        failed.push(botId)
      }
    }
    return failed
  }

  /** Whether `api`'s key reaches the first bot session saved under the current key. */
  private async reachesBotSession(api: ComposioApi): Promise<boolean> {
    for (const botId of this.deps.botIds()) {
      const server = await this.deps
        .cliOf(botId)
        .then(async (cli) => composioServerOf(await readBotToolServers(cli.folder)))
        .catch(() => undefined)
      const sessionId = server && 'url' in server ? sessionIdOf(server.url) : null
      if (sessionId) {
        return api.refreshSession(sessionId).catch(() => false)
      }
    }
    return false
  }

  /** One deliberate call past a held limit, as the owner checks whether it lifted. */
  async checkLimit(): Promise<void> {
    await this.withKey((api) => api.apps({ limit: 1 }), { deliberate: true })
  }

  async apps(options: { search?: string; cursor?: string }): Promise<ComposioAppPage> {
    const page = await this.withKey((api) => appsWithOwnerSetUp(api, options))
    this.names.remember(page.apps)
    return page
  }

  /** One app, as the setup card checks it again after the owner set it up in Composio. */
  async app(slug: string): Promise<ComposioApp> {
    return this.withKey((api) => appWithOwnerSetUp(api, slug))
  }

  async connections(botId: string): Promise<ComposioConnections> {
    const connections = await this.withKey((api) => api.connections(composioUserOfBot(botId)))
    return {
      connections: await this.names.named(
        (slug) => this.withKey((api) => api.app(slug)),
        // Links nobody finished (still open, or abandoned) aren't sign-ins.
        connections.filter(
          (connection) => connection.status !== 'pending' && connection.status !== 'failed'
        )
      ),
      pending: this.waits.of(botId)
    }
  }

  /** Gives the bot its Composio tool if it has none, then a link to the app's sign-in, and waits on it. */
  async connect(
    botId: string,
    app: string,
    card: ComposioConnectCard = null
  ): Promise<{ url: string }> {
    const sessionId = await this.ensureTool(botId)
    const link = await this.withKey((api) => linkWithOwnerSetUp(api, sessionId, app))
    this.waits.start(botId, app, link, card)
    return { url: link.url }
  }

  cancelConnect(botId: string, app: string): void {
    this.waits.cancel(botId, app)
  }

  /** Signs the app out at Composio; only one of this bot's own sign-ins. */
  async disconnect(botId: string, accountId: string): Promise<void> {
    await this.withKey(async (api) => {
      const owned = await api.connections(composioUserOfBot(botId))
      if (!owned.some((connection) => connection.id === accountId)) {
        throw new Error('This bot has no such app sign-in.')
      }
      await api.disconnect(accountId)
    })
    this.deps.onChange()
  }

  /** The bot's Composio tool; made, with a session for the bot's user, when it has none. One at a
   *  time per bot, so two Connects at once share one session. */
  ensureTool(botId: string): Promise<string> {
    const previous = this.ensuring.get(botId) ?? Promise.resolve('')
    const next = previous.catch(() => '').then(() => this.ensureToolNow(botId))
    this.ensuring.set(botId, next)
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.ensuring.get(botId) === next) {
          this.ensuring.delete(botId)
        }
      })
    return next
  }

  private async ensureToolNow(botId: string): Promise<string> {
    const { sessionId, changed } = await ensureComposioTool({
      cli: await this.deps.cliOf(botId),
      botId,
      call: (work) => this.withKey(work)
    })
    if (changed) {
      this.deps.onChange()
    }
    return sessionId
  }

  /** Takes the Composio tool off the bot; its sign-ins stay at Composio for when it's added back. */
  async removeFromBot(botId: string): Promise<void> {
    const cli = await this.deps.cliOf(botId)
    const server = composioServerOf(await readBotToolServers(cli.folder))
    this.waits.cancelAll(botId)
    if (server) {
      await removeBotTool(cli, server.name)
    }
    this.deps.onChange()
  }

  /** Before a delete: lists the bot for cleanup in the saved key's project, so a crash
   *  mid-delete still cleans it up. Nothing is removed while the bot is still here. */
  async willDelete(botId: string): Promise<void> {
    const key = this.deps.keys.read()
    this.cleanup.add({ botId, project: key ? composioProjectOf(key) : null })
  }

  /** After a delete: the bot's waits, and its sign-ins and triggers at Composio, now or once its
   *  project's key works; a failure here never fails the delete. */
  async forget(botId: string): Promise<void> {
    this.waits.forget(botId)
    await this.drainCleanup()
  }

  /** Cleans up deleted bots still listed; at startup, after a key is saved, and on each sweep. */
  async drainCleanup(): Promise<void> {
    const key = this.deps.keys.read()
    if (key && this.keyState() === 'ok' && this.cleanup.pending().length > 0) {
      const live = this.deps.botExists ?? ((botId) => this.deps.botIds().includes(botId))
      await this.withKey((api) => this.cleanup.drain(api, key, live)).catch((error: unknown) =>
        console.warn('[composio] cleaning up deleted bots failed', error)
      )
    }
  }

  /** A Reconnect's new sign-in replaces the app's old ones, so the bot has one account per app. */
  private async dropOtherSignIns(botId: string, kept: ComposioConnection): Promise<void> {
    await this.withKey((api) => api.disconnectOthers(composioUserOfBot(botId), kept)).catch(
      (error: unknown) => console.warn('[composio] dropping an old sign-in failed', error)
    )
  }

  private requireKey(): string {
    const key = this.deps.keys.read()
    if (!key) {
      throw new Error('Add your Composio key first.')
    }
    return key
  }

  /** Runs a call with the saved key, noting when Composio refuses it so every client can say so.
   *  While a limit holds only a deliberate call goes out. */
  async withKey<T>(
    call: (api: ComposioApi) => Promise<T>,
    options: { deliberate?: boolean } = {}
  ): Promise<T> {
    const key = this.requireKey()
    const api = this.api(key)
    const held = options.deliberate ? null : this.health.holding()
    if (held) {
      throw held
    }
    const ticket = this.health.ticket()
    // A replaced key's late answer is its caller's alone; it says nothing about the saved key.
    const current = () => this.deps.keys.read() === key
    try {
      const result = await call(api)
      if (current()) {
        this.health.answered(ticket)
      }
      return result
    } catch (error) {
      if (current()) {
        this.health.failed(error)
      }
      throw error
    }
  }
}
