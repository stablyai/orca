// A bot's picture becomes its Slack app's icon, and the picture the cloud's own pages show (GitHub's
// choose page): the cloud gets the picture of each bot with a Slack app or a GitHub link whenever it
// differs from the one last sent, and sets the icon itself.
import { parseBotAvatar } from '../../shared/bot-avatar'
import type { Bot } from '../../shared/bot-types'
import type { ConnectorBotAvatarRequest } from '../../shared/connector-bot-slack-contract'
import type { BotController } from '../bots/bot-controller'
import { botsCloudClient } from './bots-cloud-client'
import type { ConnectorCloud } from './connector-cloud'

type SyncedBot = Pick<Bot, 'id' | 'avatar' | 'slack' | 'github'>

// A failed send tries again after this, unless a bot write retries it first.
const RETRY_MS = 60_000
// A picture the cloud refused for a bot it doesn't know (yet: the hello registering it may still be
// on its way) waits this long, doubling per refusal up to the cap, unless a bot write comes first.
const MAX_REFUSED_WAIT_MS = 30 * 60_000
// Sends in flight at once, so a large roster never fans out into one request per bot.
const MAX_CONCURRENT_SENDS = 4

export class BotAvatarSync {
  // Per bot, the avatar the cloud last took.
  private readonly sent = new Map<string, string>()
  // One send per bot at a time, so an older picture never lands after a newer one.
  private readonly sending = new Set<string>()
  // Per bot, the avatar the cloud refused as an unknown bot, and until when it waits.
  private readonly refused = new Map<string, { avatar: string; waitMs: number; until: number }>()
  // Bots waiting for a send slot, each as last seen.
  private readonly queued = new Map<string, SyncedBot>()
  // Bots a pass met while their send was in flight: their picture may have changed since.
  private readonly changedWhileSending = new Set<string>()
  // Bot writes so far, so a refusal that crossed one is not kept.
  private writes = 0
  private retry: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly deps: {
      bots: Pick<BotController, 'enabled' | 'readAvatarImage'> & {
        list: () => SyncedBot[]
      }
      cloud: () => Pick<ConnectorCloud, 'call'> | null
    }
  ) {}

  /** After any bot write, and once at start for changes made while signed out or offline. */
  changed(): void {
    // A write may be what registers a refused bot with the cloud: everything is tried again.
    this.writes++
    this.refused.clear()
    this.pass()
  }

  private pass(): void {
    if (!this.deps.bots.enabled()) {
      return
    }
    let waiting = false
    for (const bot of this.deps.bots.list()) {
      if (!(bot.slack || bot.github) || !bot.avatar || this.sent.get(bot.id) === bot.avatar) {
        continue
      }
      if (this.sending.has(bot.id)) {
        this.changedWhileSending.add(bot.id)
        continue
      }
      const refused = this.refused.get(bot.id)
      if (refused?.avatar === bot.avatar && Date.now() < refused.until) {
        waiting = true
        continue
      }
      this.queued.set(bot.id, bot)
    }
    if (waiting) {
      this.retryLater()
    }
    this.pump()
  }

  private pump(): void {
    for (const [id, bot] of this.queued) {
      if (this.sending.size >= MAX_CONCURRENT_SENDS) {
        return
      }
      this.queued.delete(id)
      if (bot.avatar && !this.sending.has(id)) {
        void this.send(bot, bot.avatar)
      }
    }
  }

  private retryLater(): void {
    this.retry ??= setTimeout(() => {
      this.retry = null
      this.pass()
    }, RETRY_MS)
    this.retry.unref?.()
  }

  private async send(bot: SyncedBot, avatar: string): Promise<void> {
    const parsed = parseBotAvatar(avatar)
    // An emoji or the initial leaves the app's icon as it is.
    if (parsed?.kind !== 'mascot' && parsed?.kind !== 'upload') {
      return
    }
    const cloud = this.deps.cloud()
    if (!cloud) {
      return
    }
    this.sending.add(bot.id)
    const writes = this.writes
    let sent = false
    let refused = false
    try {
      const png = parsed.kind === 'upload' ? await this.deps.bots.readAvatarImage(bot.id) : null
      const body: ConnectorBotAvatarRequest | null =
        parsed.kind === 'mascot'
          ? { v: 1, kind: 'mascot', id: parsed.id }
          : png && { v: 1, kind: 'upload', version: parsed.version, png: png.toString('base64') }
      const result = body && (await botsCloudClient(cloud).setAvatar(bot.id, body))
      sent = result?.ok === true
      refused = result?.ok === false && result.error === 'unknown_bot'
    } catch (error) {
      console.error('Failed to send the bot’s picture to the cloud:', error)
    }
    this.sending.delete(bot.id)
    if (sent) {
      this.sent.set(bot.id, avatar)
      // The picture may have changed while this one was on its way: only then is the roster read again.
      if (this.changedWhileSending.delete(bot.id)) {
        this.pass()
      }
    } else if (refused && writes === this.writes) {
      // The cloud doesn't know this bot: it is asked again less and less often, or after a write.
      const before = this.refused.get(bot.id)
      const waitMs = Math.min(
        before?.avatar === avatar ? before.waitMs * 2 : RETRY_MS,
        MAX_REFUSED_WAIT_MS
      )
      this.refused.set(bot.id, { avatar, waitMs, until: Date.now() + waitMs })
      this.retryLater()
    } else if (refused) {
      // A bot write came in meanwhile and may have registered it, or changed its picture.
      this.pass()
    } else {
      this.retryLater()
    }
    this.changedWhileSending.delete(bot.id)
    this.pump()
  }
}
