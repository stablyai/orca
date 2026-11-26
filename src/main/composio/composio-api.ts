// Composio's REST API, called with the owner's project key from the bot's host; never from a bot.
import { z } from 'zod'
import type {
  ComposioApp,
  ComposioAppPage,
  ComposioConnection
} from '../../shared/composio/composio-apps'
import {
  Account,
  AccountPage,
  AuthConfigPage,
  Link,
  RotatedSecret,
  Session,
  SessionConfig,
  Subscription,
  SubscriptionPage,
  COMPOSIO_EVENTS,
  Toolkit,
  ToolkitPage,
  TriggerInstancePage,
  TriggerPage,
  TriggerType,
  appOf,
  connectionOf,
  subscriptionOf,
  type ComposioWebhookSubscription
} from './composio-api-answers'

const API = 'https://backend.composio.dev/api/v3.1'
// The bot connects apps only through Orca's Connect card, so Composio never hands it a raw link.
// The remote workbench is a second place code runs with the owner's sign-ins; the bot has a shell.
const SESSION_SETTINGS = { manage_connections: { enable: false }, workbench: { enable: false } }
const TIMEOUT_MS = 15_000

import {
  COMPOSIO_RETRY_WAIT_MAX_MS,
  ComposioKeyRejectedError,
  ComposioKeyScopeError,
  ComposioLimitError,
  ComposioNeedsOwnSignInError,
  ComposioNotFoundError,
  ComposioUnavailableError,
  composioErrorOf,
  isComposioLimit,
  isComposioPlanLimit,
  parseJson,
  retryAfterMs
} from './composio-api-errors'

export {
  ComposioKeyRejectedError,
  ComposioKeyScopeError,
  ComposioLimitError,
  ComposioNeedsOwnSignInError,
  ComposioUnavailableError
} from './composio-api-errors'

type Fetch = typeof fetch

export class ComposioApi {
  constructor(
    private readonly key: string,
    private readonly fetchImpl: Fetch = fetch
  ) {}

  private async call<T>(
    path: string,
    schema: z.ZodType<T>,
    init: { method?: string; body?: unknown } = {},
    retried = false
  ): Promise<T> {
    let response: Response
    try {
      response = await this.fetchImpl(`${API}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          'x-api-key': this.key,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
    } catch {
      throw new ComposioUnavailableError('Composio didn’t answer. Check your connection.')
    }
    const json = parseJson(await response.text())
    // 403 is one endpoint the key may not use; only 401 says the key itself is refused.
    if (response.status === 401) {
      throw new ComposioKeyRejectedError()
    }
    if (response.status === 404) {
      throw new ComposioNotFoundError('Composio no longer has this.')
    }
    if (!response.ok) {
      const error = composioErrorOf(json)
      if (response.status === 403 && error?.slug === 'APIKey_InsufficientPermissions') {
        throw new ComposioKeyScopeError(error.message)
      }
      if (error?.slug === 'ToolRouterV2_NoManagedAuth') {
        throw new ComposioNeedsOwnSignInError(path)
      }
      if (isComposioLimit(response.status, error?.slug, error?.message)) {
        const wait = retryAfterMs(response.headers.get('retry-after'), Date.now())
        if (wait !== null && wait <= COMPOSIO_RETRY_WAIT_MAX_MS && !retried) {
          await new Promise((resolve) => setTimeout(resolve, wait))
          return this.call(path, schema, init, true)
        }
        const plan = isComposioPlanLimit(response.status, error?.slug, error?.message)
        throw new ComposioLimitError(plan ? null : Date.now() + (wait ?? 60_000), error?.message)
      }
      throw new ComposioUnavailableError(
        error?.message ? `Composio: ${error.message}` : `Composio answered ${response.status}.`
      )
    }
    const parsed = schema.safeParse(json)
    if (!parsed.success) {
      throw new ComposioUnavailableError('Composio sent an answer Orca couldn’t read.')
    }
    return parsed.data
  }

  /** For the calls kept in their own modules (composio-api-events.ts). */
  send<T>(path: string, schema: z.ZodType<T>, init?: { method?: string; body?: unknown }) {
    return this.call(path, schema, init)
  }

  /** Apps by use, Composio's search matching whole words of the name. */
  async apps(options: {
    search?: string
    cursor?: string
    limit?: number
  }): Promise<ComposioAppPage> {
    const query = new URLSearchParams({ sort_by: 'usage', limit: String(options.limit ?? 30) })
    if (options.search?.trim()) {
      query.set('search', options.search.trim())
    }
    if (options.cursor) {
      query.set('cursor', options.cursor)
    }
    const page = await this.call(`/toolkits?${query}`, ToolkitPage)
    // Composio's own meta-toolkit is the session itself, not an app to connect.
    const apps = page.items.filter((item) => item.slug !== 'composio').map(appOf)
    return { apps, nextCursor: page.next_cursor ?? null }
  }

  async app(slug: string): Promise<ComposioApp> {
    return appOf(await this.call(`/toolkits/${encodeURIComponent(slug)}`, Toolkit))
  }

  /** Makes a session for the bot's Composio user; its MCP server is the bot's Composio tool. */
  async createSession(userId: string): Promise<{ id: string; mcpUrl: string }> {
    const session = await this.call('/tool_router/session', Session, {
      method: 'POST',
      body: { user_id: userId, ...SESSION_SETTINGS }
    })
    return { id: session.session_id, mcpUrl: session.mcp.url }
  }

  /** Brings a session made earlier to Orca's settings, in place; false when Composio no longer has it. */
  async refreshSession(sessionId: string): Promise<boolean> {
    try {
      await this.call(`/tool_router/session/${encodeURIComponent(sessionId)}`, z.unknown(), {
        method: 'PATCH',
        body: SESSION_SETTINGS
      })
      return true
    } catch (error) {
      if (error instanceof ComposioNotFoundError) {
        return false
      }
      throw error
    }
  }

  /** The user's trigger instances, paused ones too. */
  async triggers(userId: string): Promise<{ id: string; trigger: string }[]> {
    const query = new URLSearchParams({ user_ids: userId, show_disabled: 'true' })
    const items = await this.everyPage('/trigger_instances/active', query, TriggerInstancePage)
    return items.map((item) => ({ id: item.id, trigger: item.trigger_name }))
  }

  async deleteTrigger(id: string): Promise<void> {
    await this.call(`/trigger_instances/manage/${encodeURIComponent(id)}`, z.unknown(), {
      method: 'DELETE'
    })
  }

  /** The apps the owner set up a sign-in for in Composio's Auth Configs. */
  async authConfigApps(): Promise<Map<string, string>> {
    const apps = new Map<string, string>()
    for (const config of await this.everyPage(
      '/auth_configs',
      new URLSearchParams(),
      AuthConfigPage
    )) {
      if (config.status !== 'DISABLED' && !apps.has(config.toolkit.slug)) {
        apps.set(config.toolkit.slug, config.id)
      }
    }
    return apps
  }

  /** Has the session sign in to `app` through the owner's own auth config; others are kept. */
  async useAuthConfig(sessionId: string, app: string, authConfigId: string): Promise<void> {
    const path = `/tool_router/session/${encodeURIComponent(sessionId)}`
    const current = await this.call(path, SessionConfig)
    await this.call(path, z.unknown(), {
      method: 'PATCH',
      body: { auth_configs: { ...current.config?.auth_configs, [app]: authConfigId } }
    })
  }

  /** A short-lived link to the app's sign-in at Composio, and the sign-in it will become. */
  async connectLink(sessionId: string, app: string): Promise<{ url: string; accountId: string }> {
    try {
      const link = await this.call(
        `/tool_router/session/${encodeURIComponent(sessionId)}/link`,
        Link,
        { method: 'POST', body: { toolkit: app } }
      )
      return { url: link.redirect_url, accountId: link.connected_account_id }
    } catch (error) {
      if (error instanceof ComposioNeedsOwnSignInError) {
        throw new ComposioNeedsOwnSignInError(app)
      }
      throw error
    }
  }

  /** Signs the user out of the app's other sign-ins, keeping `kept`. */
  async disconnectOthers(userId: string, kept: ComposioConnection): Promise<void> {
    for (const other of await this.connections(userId)) {
      if (other.app === kept.app && other.id !== kept.id) {
        await this.disconnect(other.id)
      }
    }
  }

  async connections(userId: string): Promise<ComposioConnection[]> {
    const query = new URLSearchParams({ user_ids: userId })
    return (await this.everyPage('/connected_accounts', query, AccountPage)).map(connectionOf)
  }

  /** Every page of a list; the cap keeps a runaway cursor from looping. */
  private async everyPage<I>(
    path: string,
    query: URLSearchParams,
    schema: z.ZodType<{ items: I[]; next_cursor?: string | null }>
  ): Promise<I[]> {
    const all: I[] = []
    let cursor: string | null = null
    for (let page = 0; page < 20; page += 1) {
      const pageQuery = new URLSearchParams(query)
      pageQuery.set('limit', '100')
      if (cursor) {
        pageQuery.set('cursor', cursor)
      }
      const result = await this.call(`${path}?${pageQuery}`, schema)
      all.push(...result.items)
      cursor = result.next_cursor ?? null
      if (!cursor) {
        return all
      }
    }
    throw new ComposioUnavailableError('Composio’s list didn’t end.')
  }

  async connection(accountId: string): Promise<ComposioConnection> {
    return connectionOf(
      await this.call(`/connected_accounts/${encodeURIComponent(accountId)}`, Account)
    )
  }

  /** Where the project sends its trigger events; Composio keeps one subscription per project. */
  async webhookSubscriptions(): Promise<ComposioWebhookSubscription[]> {
    const page = await this.call('/webhook_subscriptions', SubscriptionPage)
    return page.items.map(subscriptionOf)
  }

  /** Points the project's trigger events at `url`; Composio answers with the signing secret. */
  async sendEventsTo(url: string, replacing?: string): Promise<ComposioWebhookSubscription> {
    const body = { webhook_url: url, enabled_events: COMPOSIO_EVENTS }
    return subscriptionOf(
      replacing
        ? await this.call(`/webhook_subscriptions/${encodeURIComponent(replacing)}`, Subscription, {
            method: 'PATCH',
            body
          })
        : await this.call('/webhook_subscriptions', Subscription, { method: 'POST', body })
    )
  }

  /** A new signing secret, for an answer that came back without one. */
  async rotateSecret(id: string): Promise<string | null> {
    const answer = await this.call(
      `/webhook_subscriptions/${encodeURIComponent(id)}/rotate_secret`,
      RotatedSecret,
      { method: 'POST' }
    )
    return answer.secret ?? null
  }

  /** A trigger's name and the app it belongs to. */
  async triggerType(trigger: string): Promise<{ name: string; app: string }> {
    const type = await this.call(`/triggers_types/${encodeURIComponent(trigger)}`, TriggerType)
    return { name: type.name, app: type.toolkit.slug }
  }

  /** Whether the trigger is on for the user. */
  async triggerOn(userId: string, trigger: string): Promise<boolean> {
    const query = new URLSearchParams({ user_ids: userId, trigger_names: trigger })
    const page = await this.call(`/trigger_instances/active?${query}`, TriggerPage)
    return page.items.length > 0
  }

  /** Turns the trigger on for the user's signed-in account; Composio picks the account. */
  async turnOnTrigger(
    userId: string,
    trigger: string,
    config: Record<string, unknown>
  ): Promise<void> {
    await this.call(`/trigger_instances/${encodeURIComponent(trigger)}/upsert`, z.unknown(), {
      method: 'POST',
      body: { user_id: userId, trigger_config: config }
    })
  }

  async disconnect(accountId: string): Promise<void> {
    await this.call(`/connected_accounts/${encodeURIComponent(accountId)}`, z.unknown(), {
      method: 'DELETE'
    })
  }
}
