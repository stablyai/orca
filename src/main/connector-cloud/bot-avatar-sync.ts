// A bot's picture becomes its Slack app's icon: the cloud gets the picture of each bot with an app
// whenever it differs from the one last sent, and sets the icon itself.
import { parseBotAvatar } from '../../shared/bot-avatar'
import type { Bot } from '../../shared/bot-types'
import type { ConnectorBotAvatarRequest } from '../../shared/connector-bot-slack-contract'
import type { BotController } from '../bots/bot-controller'
import { botsCloudClient } from './bots-cloud-client'
import type { ConnectorCloud } from './connector-cloud'

type SyncedBot = Pick<Bot, 'id' | 'avatar' | 'slack'>

// A failed send tries again after this, unless a bot write retries it first.
const RETRY_MS = 60_000

export class BotAvatarSync {
  // Per bot, the avatar the cloud last took.
  private readonly sent = new Map<string, string>()
  // One send per bot at a time, so an older picture never lands after a newer one.
  private readonly sending = new Set<string>()
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
    if (!this.deps.bots.enabled()) {
      return
    }
    for (const bot of this.deps.bots.list()) {
      if (
        bot.slack &&
        bot.avatar &&
        this.sent.get(bot.id) !== bot.avatar &&
        !this.sending.has(bot.id)
      ) {
        void this.send(bot, bot.avatar)
      }
    }
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
    let sent = false
    try {
      const png = parsed.kind === 'upload' ? await this.deps.bots.readAvatarImage(bot.id) : null
      const body: ConnectorBotAvatarRequest | null =
        parsed.kind === 'mascot'
          ? { v: 1, kind: 'mascot', id: parsed.id }
          : png && { v: 1, kind: 'upload', version: parsed.version, png: png.toString('base64') }
      sent = body !== null && (await botsCloudClient(cloud).setAvatar(bot.id, body)).ok
    } catch (error) {
      console.error('Failed to send the bot’s picture to Slack:', error)
    }
    this.sending.delete(bot.id)
    if (sent) {
      this.sent.set(bot.id, avatar)
      // The picture may have changed while this one was on its way.
      this.changed()
    } else {
      this.retry ??= setTimeout(() => {
        this.retry = null
        this.changed()
      }, RETRY_MS)
      this.retry.unref?.()
    }
  }
}
