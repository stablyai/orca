// The Connects this host is waiting on, per bot and app: each polls its sign-in at Composio until it
// ends or the wait runs out, and a newer Connect or a Cancel replaces it.
import type {
  ComposioConnection,
  ComposioPendingConnect
} from '../../shared/composio/composio-apps'

const CONNECT_WAIT_MS = 10 * 60_000
const CONNECT_POLL_MS = 2_000

export type ComposioConnectCard = { name: string; reason?: 'expired' } | null

type Wait = ComposioPendingConnect & {
  accountId: string
  card: ComposioConnectCard
  timer: ReturnType<typeof setTimeout>
}

export type ComposioConnectWaitsDeps = {
  /** The sign-in as Composio has it now; null when it couldn't be read. */
  read: (accountId: string) => Promise<ComposioConnection | null>
  onChange: () => void
  /** A wait ended: signed in (`connection`), failed, or ran out. */
  ended: (
    botId: string,
    app: string,
    connection: ComposioConnection | null,
    card: ComposioConnectCard
  ) => Promise<void>
  now: () => number
}

export class ComposioConnectWaits {
  private readonly waits = new Map<string, Map<string, Wait>>()

  constructor(private readonly deps: ComposioConnectWaitsDeps) {}

  of(botId: string): ComposioPendingConnect[] {
    return [...(this.waits.get(botId)?.values() ?? [])].map(({ app, url, startedAt }) => ({
      app,
      url,
      startedAt
    }))
  }

  start(
    botId: string,
    app: string,
    link: { url: string; accountId: string },
    card: ComposioConnectCard
  ): void {
    this.cancel(botId, app)
    let waits = this.waits.get(botId)
    if (!waits) {
      waits = new Map()
      this.waits.set(botId, waits)
    }
    waits.set(app, {
      app,
      url: link.url,
      accountId: link.accountId,
      card,
      startedAt: this.deps.now(),
      timer: setTimeout(() => void this.poll(botId, app), CONNECT_POLL_MS)
    })
    this.deps.onChange()
  }

  cancel(botId: string, app: string): void {
    const wait = this.waits.get(botId)?.get(app)
    if (!wait) {
      return
    }
    clearTimeout(wait.timer)
    this.waits.get(botId)?.delete(app)
    this.deps.onChange()
  }

  cancelAll(botId: string): void {
    for (const app of this.waits.get(botId)?.keys() ?? []) {
      this.cancel(botId, app)
    }
  }

  /** A deleted bot's waits, dropped without telling anyone. */
  forget(botId: string): void {
    for (const wait of this.waits.get(botId)?.values() ?? []) {
      clearTimeout(wait.timer)
    }
    this.waits.delete(botId)
  }

  private async poll(botId: string, app: string): Promise<void> {
    const wait = this.waits.get(botId)?.get(app)
    if (!wait) {
      return
    }
    const connection = await this.deps.read(wait.accountId).catch(() => null)
    // A newer Connect or a Cancel replaced this wait while the read was out.
    if (this.waits.get(botId)?.get(app) !== wait) {
      return
    }
    const ended =
      (connection && connection.status !== 'pending') ||
      this.deps.now() - wait.startedAt >= CONNECT_WAIT_MS
    if (!ended) {
      wait.timer = setTimeout(() => void this.poll(botId, app), CONNECT_POLL_MS)
      return
    }
    this.waits.get(botId)?.delete(app)
    await this.deps.ended(
      botId,
      app,
      connection?.status === 'active' ? connection : null,
      wait.card
    )
  }
}
