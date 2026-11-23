// A bot's picture becomes its Slack app's icon, and the picture the cloud's own pages show (GitHub's
// choose page): the cloud gets the picture of each bot with a Slack app or a GitHub link whenever it
// differs from the one last sent, and sets the icon itself. A mascot with a color or outfit goes as the
// PNG a window drew of it; until one is drawn for its look, as the plain mascot.
import { createHash } from 'node:crypto'
import { parseBotAvatar } from '../../shared/bot-avatar'
import { botSlackIconLook } from '../../shared/bots/bot-slack-icon'
import { type BotLookupIndex, createBotLookupIndex } from '../../shared/bots/bot-lookup-index'
import type { Bot } from '../../shared/bot-types'
import type { ConnectorBotAvatarRequest } from '../../shared/connector-bot-slack-contract'
import type { BotController } from '../bots/bot-controller'
import type { BotSlackIcons } from '../bots/bot-slack-icon-store'
import { botsCloudClient } from './bots-cloud-client'
import type { ConnectorCloud } from './connector-cloud'

type SyncedBot = Pick<
  Bot,
  'id' | 'folderWorkspaceId' | 'avatar' | 'avatarColor' | 'avatarOutfit' | 'slack' | 'github'
>

// A failed send tries again after this, unless a bot write retries it first.
const RETRY_MS = 60_000
// A picture the cloud refused for a bot it doesn't know (yet: the hello registering it may still be
// on its way) waits this long, doubling per refusal up to the cap, unless a bot write comes first.
const MAX_REFUSED_WAIT_MS = 30 * 60_000
// Sends in flight at once, so a large roster never fans out into one request per bot.
const MAX_CONCURRENT_SENDS = 4

// What the cloud is sent for a bot: its picture and, for a colored or dressed mascot, its look.
function pictureKey(bot: SyncedBot): string {
  return `${bot.avatar ?? ''}|${botSlackIconLook(bot) ?? ''}`
}

export class BotAvatarSync {
  // Per bot, the picture key the cloud last took.
  private readonly sent = new Map<string, string>()
  // One send per bot at a time, so an older picture never lands after a newer one; the picture in flight.
  private readonly sending = new Map<string, string>()
  // Per bot, the avatar the cloud refused as an unknown bot, and until when it waits.
  private readonly refused = new Map<string, { avatar: string; waitMs: number; until: number }>()
  // Bots waiting for a send slot, each as last seen.
  private readonly queued = new Map<string, SyncedBot>()
  // A picture changed while bots were off: the roster is read again once they are on.
  private staleWhileOff = false
  // Bots a pass met while their send was in flight: their picture may have changed since.
  private readonly changedWhileSending = new Set<string>()
  // Bot writes so far, so a refusal that crossed one is not kept.
  private writes = 0
  // Per bot, drawn icons kept so far, so a send that read none before one was kept is sent again.
  private readonly icons = new Map<string, number>()
  // Per bot, its drawn icon while a send of it is out or to be retried, by look and icon count.
  private readonly prepared = new Map<
    string,
    { look: string; icons: number; icon: { version: string; png: string } }
  >()
  private retry: ReturnType<typeof setTimeout> | null = null
  private readonly lookup: BotLookupIndex<SyncedBot>

  constructor(
    private readonly deps: {
      bots: Pick<BotController, 'enabled' | 'readAvatarImage'> & {
        list: () => SyncedBot[]
        slackIcons: Pick<BotSlackIcons, 'read'>
      }
      cloud: () => Pick<ConnectorCloud, 'call'> | null
    }
  ) {
    this.lookup = createBotLookupIndex(() => this.deps.bots.list())
  }

  /** After any bot write, and once at start for changes made while signed out or offline. */
  changed(): void {
    // A write may be what registers a refused bot with the cloud: everything is tried again.
    this.writes++
    this.refused.clear()
    this.pass()
  }

  /** A window drew the bot's icon for its look: what was sent without it goes again. */
  iconStored(botId: string): void {
    this.icons.set(botId, (this.icons.get(botId) ?? 0) + 1)
    this.sent.delete(botId)
    // One in flight read no icon or an older one: it is sent again once it lands.
    if (!this.sending.has(botId)) {
      this.resend(botId)
    }
  }

  // Only this bot is queued again: one stored icon never rereads the whole roster's pictures.
  private resend(botId: string): void {
    // With bots off it waits, unsent, for the next pass (the next bot write) instead of a timer.
    if (!this.deps.bots.enabled()) {
      return
    }
    const bot = this.lookup.byId(botId)
    if (bot && (bot.slack || bot.github) && bot.avatar) {
      this.queued.set(bot.id, bot)
      this.pump()
    }
  }

  private pass(): void {
    if (!this.deps.bots.enabled()) {
      // Queued sends resume when bots are enabled again.
      if (this.queued.size > 0 || this.staleWhileOff) {
        this.retryLater()
      }
      if (this.sending.size > 0) {
        for (const bot of this.deps.bots.list()) {
          const flying = this.sending.get(bot.id)
          if (flying !== undefined && flying !== pictureKey(bot)) {
            this.changedWhileSending.add(bot.id)
          }
        }
      }
      return
    }
    this.staleWhileOff = false
    let waiting = false
    const present = new Set<string>()
    for (const bot of this.deps.bots.list()) {
      present.add(bot.id)
      if (!(bot.slack || bot.github) || !bot.avatar) {
        this.queued.delete(bot.id)
        continue
      }
      const flying = this.sending.get(bot.id)
      if (flying !== undefined) {
        // Only a picture other than the one in flight needs a look once it lands.
        if (flying !== pictureKey(bot)) {
          this.changedWhileSending.add(bot.id)
        }
        continue
      }
      if (this.sent.get(bot.id) === pictureKey(bot)) {
        this.queued.delete(bot.id)
        continue
      }
      const refused = this.refused.get(bot.id)
      if (refused?.avatar === pictureKey(bot) && Date.now() < refused.until) {
        waiting = true
        continue
      }
      this.queued.set(bot.id, bot)
    }
    // A bot deleted while it waited for a slot is not sent, and keeps no icon count.
    for (const id of this.queued.keys()) {
      if (!present.has(id)) {
        this.queued.delete(id)
      }
    }
    for (const id of this.icons.keys()) {
      if (!present.has(id)) {
        this.icons.delete(id)
      }
    }
    for (const id of this.prepared.keys()) {
      if (!present.has(id)) {
        this.prepared.delete(id)
      }
    }
    if (waiting) {
      this.retryLater()
    }
    this.pump()
  }

  private pump(): void {
    if (!this.deps.bots.enabled()) {
      // Queued sends resume when bots are enabled again.
      if (this.queued.size > 0) {
        this.retryLater()
      }
      return
    }
    for (const [id, bot] of this.queued) {
      if (this.sending.size >= MAX_CONCURRENT_SENDS) {
        return
      }
      this.queued.delete(id)
      if (bot.avatar && !this.sending.has(id)) {
        void this.send(bot, pictureKey(bot))
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
    const parsed = parseBotAvatar(bot.avatar)
    // An emoji or the initial leaves the app's icon as it is.
    if (parsed?.kind !== 'mascot' && parsed?.kind !== 'upload') {
      return
    }
    const cloud = this.deps.cloud()
    if (!cloud) {
      return
    }
    this.sending.set(bot.id, avatar)
    const writes = this.writes
    const icons = this.icons.get(bot.id)
    let sent = false
    let refused = false
    try {
      const png = parsed.kind === 'upload' ? await this.deps.bots.readAvatarImage(bot.id) : null
      const icon = parsed.kind === 'mascot' ? await this.mascotIcon(bot) : null
      const body: ConnectorBotAvatarRequest | null = icon
        ? { v: 1, kind: 'upload', version: icon.version, png: icon.png }
        : parsed.kind === 'mascot'
          ? { v: 1, kind: 'mascot', id: parsed.id }
          : png && { v: 1, kind: 'upload', version: parsed.version, png: png.toString('base64') }
      const result = body && (await botsCloudClient(cloud).setAvatar(bot.id, body))
      sent = result?.ok === true
      refused = result?.ok === false && result.error === 'unknown_bot'
    } catch (error) {
      console.error('Failed to send the bot’s picture to the cloud:', error)
    }
    this.sending.delete(bot.id)
    if (sent && icons !== this.icons.get(bot.id)) {
      // An icon was kept after this send read none: it goes next.
      this.sent.delete(bot.id)
      this.changedWhileSending.delete(bot.id)
      this.resend(bot.id)
    } else if (sent) {
      this.sent.set(bot.id, avatar)
      // Kept only for a retry: once taken, its bytes are let go.
      this.prepared.delete(bot.id)
      // The picture may have changed while this one was on its way: only then is the roster read again.
      if (this.changedWhileSending.delete(bot.id)) {
        // While bots are off a pass only reads again once they are on.
        if (this.deps.bots.enabled()) {
          this.pass()
        } else {
          this.staleWhileOff = true
          this.retryLater()
        }
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
      // The cloud may have taken it before the answer was lost: what it holds is unknown.
      this.sent.delete(bot.id)
      this.retryLater()
    }
    this.changedWhileSending.delete(bot.id)
    this.pump()
  }

  // The drawn icon for the mascot's look now, named by its bytes as an upload is; null sends the plain mascot.
  // The drawn icon for the mascot's look now, named by its bytes as an upload is; null sends the plain
  // mascot. Kept per bot until its look or icon changes, so a retry (signed out, offline) reads nothing.
  private async mascotIcon(bot: SyncedBot): Promise<{ version: string; png: string } | null> {
    const look = botSlackIconLook(bot)
    if (!look) {
      this.prepared.delete(bot.id)
      return null
    }
    const icons = this.icons.get(bot.id) ?? 0
    const kept = this.prepared.get(bot.id)
    if (kept?.look === look && kept.icons === icons) {
      return kept.icon
    }
    const read = await this.deps.bots.slackIcons.read(bot.id)
    const icon =
      read?.look === look
        ? {
            version: createHash('sha256').update(read.png).digest('hex').slice(0, 16),
            png: read.png.toString('base64')
          }
        : null
    // A missing icon is read again on the next send, so one stored meanwhile is found.
    if (icon) {
      this.prepared.set(bot.id, { look, icons, icon })
    }
    return icon
  }
}
