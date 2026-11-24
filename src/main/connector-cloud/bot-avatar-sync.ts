// A bot's picture becomes its Slack app's icon, and the picture the cloud's own pages show (GitHub's
// choose page): the cloud gets the picture of each bot with a Slack app or a GitHub link whenever it
// differs from the one last sent, and sets the icon itself. A mascot goes as the PNG a window drew of
// its look (today's art, with its tile color and outfit or neither). Until one is drawn it goes as the
// mascot id, unless the cloud already took a drawing: that one stays, since the id shows older art.
import { createHash } from 'node:crypto'
import { parseBotAvatar } from '../../shared/bot-avatar'
import { botSlackIconLook } from '../../shared/bots/bot-slack-icon'
import { type BotLookupIndex, createBotLookupIndex } from '../../shared/bots/bot-lookup-index'
import type { Bot } from '../../shared/bot-types'
import type { ConnectorBotAvatarRequest } from '../../shared/connector-bot-slack-contract'
import type { BotController } from '../bots/bot-controller'
import type { BotSlackIcons } from '../bots/bot-slack-icon-store'
import { BotSlackIconShownRecords } from '../bots/bot-slack-icon-shown'
import { BotAvatarOwed } from './bot-avatar-owed'
import type { ConnectorBack } from './connector-reach'
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

// Per bot record (records are replaced on write, never changed in place): its look, so a pass over
// unchanged bots derives none again.
const looks = new WeakMap<SyncedBot, string | null>()

function lookOf(bot: SyncedBot): string | null {
  let look = looks.get(bot)
  if (look === undefined) {
    look = botSlackIconLook(bot)
    looks.set(bot, look)
  }
  return look
}

// What the cloud is sent for a bot: its picture and, for a mascot, its look.
function pictureKey(bot: SyncedBot): string {
  return `${bot.avatar ?? ''}|${lookOf(bot) ?? ''}`
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
  // Bots a pass met mid-send: their picture may have changed since.
  private readonly changedWhileSending = new Set<string>()
  // Real steps so far (bot writes, a sign-in), so a failure or refusal that crossed one goes again.
  private writes = 0
  // Poll outages ended so far, so a failure (never a refusal) that crossed one goes again.
  private recoveries = 0
  // Per bot, drawn icons kept so far, so a send that read none before one was kept is sent again.
  private readonly icons = new Map<string, number>()
  private readonly owed = new BotAvatarOwed()
  private readonly shown: BotSlackIconShownRecords
  // Per bot, its drawn icon while a send of it is out (or none, until one is kept), by look and icon count.
  private readonly prepared = new Map<
    string,
    { look: string; icons: number; icon: { version: string; png: string } | null }
  >()
  private retry: ReturnType<typeof setTimeout> | null = null
  private readonly lookup: BotLookupIndex<SyncedBot>

  constructor(
    private readonly deps: {
      bots: Pick<BotController, 'enabled' | 'readAvatarImage'> & {
        list: () => SyncedBot[]
        slackIcons: Pick<BotSlackIcons, 'read' | 'shownRecords'>
      }
      cloud: () =>
        | (Pick<ConnectorCloud, 'call'> & Partial<Pick<ConnectorCloud, 'signedInAccount'>>)
        | null
    }
  ) {
    this.lookup = createBotLookupIndex(() => this.deps.bots.list())
    this.shown = deps.bots.slackIcons.shownRecords
  }

  /** After any bot write, and once at start for changes made while signed out or offline. */
  changed(): void {
    // A write may be what registers a refused bot with the cloud: everything is tried again.
    this.writes++
    this.refused.clear()
    this.owed.clear()
    this.shown.stepped()
    this.pass()
  }

  /** Owed drawings go again; a fresh step (a sign-in, an outage ending) also renews sends on their way. */
  retryOwed(why: ConnectorBack): void {
    if (why === 'answered') {
      this.shown.answered()
    } else {
      this.shown.stepped()
    }
    this.writes += why === 'signedIn' ? 1 : 0
    this.recoveries += why === 'recovered' ? 1 : 0
    for (const botId of this.owed.take(why)) {
      this.sent.delete(botId)
      if (!this.sending.has(botId)) {
        this.resend(botId)
      }
    }
  }

  /** A window drew the bot's icon for its look: what was sent without it goes again. */
  iconStored(botId: string): void {
    this.icons.set(botId, (this.icons.get(botId) ?? 0) + 1)
    this.owed.delete(botId)
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

  // From the retry timer, a drawn icon the cloud failed to take is left for the next real step (a bot
  // write, bots turned on, a new drawing, a restart): an outage never resends its bytes every minute.
  private pass(fromTimer = false): void {
    if (!this.deps.bots.enabled()) {
      // Nothing is sent or scheduled while bots are off: turning them on runs a pass that reads every
      // picture again, so neither the queue nor the icon bytes kept for retries are kept.
      this.prepared.clear()
      this.queued.clear()
      return
    }
    let waiting = false
    const present = new Set<string>()
    for (const bot of this.deps.bots.list()) {
      present.add(bot.id)
      // A bot that no longer needs its drawn icon (unlinked, or another kind of picture) lets its bytes go;
      // only a bot write changes that, so the retry timer's passes skip it.
      if (!fromTimer && (!(bot.slack || bot.github) || !bot.avatar || !lookOf(bot))) {
        this.prepared.delete(bot.id)
      }
      if (!(bot.slack || bot.github) || !bot.avatar || (fromTimer && this.owed.has(bot.id))) {
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
    // A bot deleted while it waited for a slot is not sent.
    for (const id of this.queued.keys()) {
      if (!present.has(id)) {
        this.queued.delete(id)
      }
    }
    // A deleted bot keeps nothing here. Only a bot write deletes one, so the retry timer's passes skip this.
    if (!fromTimer) {
      for (const kept of [this.owed, this.icons, this.prepared, this.sent, this.refused]) {
        for (const id of kept.keys()) {
          if (!present.has(id)) {
            kept.delete(id)
          }
        }
      }
    }
    if (waiting) {
      this.retryLater()
    }
    this.pump()
  }

  private pump(): void {
    if (!this.deps.bots.enabled()) {
      // Turning bots on (the setting or the team) runs a pass that queues them again.
      this.queued.clear()
      return
    }
    for (const [id, bot] of this.queued) {
      if (this.sending.size >= MAX_CONCURRENT_SENDS) {
        return
      }
      this.queued.delete(id)
      if (bot.avatar && !this.sending.has(id)) {
        this.shown.confirming(this.send(bot, pictureKey(bot)))
      }
    }
  }

  private retryLater(): void {
    this.retry ??= setTimeout(() => {
      this.retry = null
      this.pass(true)
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
    const recoveries = this.recoveries
    const icons = this.icons.get(bot.id)
    let sent = false
    let refused = false
    let carried = false
    let left = false
    try {
      const png = parsed.kind === 'upload' ? await this.deps.bots.readAvatarImage(bot.id) : null
      const icon = parsed.kind === 'mascot' ? await this.mascotIcon(bot) : null
      const body: ConnectorBotAvatarRequest | null = icon
        ? { v: 1, kind: 'upload', version: icon.version, png: icon.png }
        : parsed.kind === 'mascot'
          ? { v: 1, kind: 'mascot', id: parsed.id }
          : png && { v: 1, kind: 'upload', version: parsed.version, png: png.toString('base64') }
      carried = icon !== null
      // The drawing the cloud last took for this bot, kept across restarts by the icon store.
      const shown = parsed.kind === 'mascot' && !icon ? await this.shown.get(bot.id) : null
      // Read after the last wait, so the hold-back and the record go by the account the send goes as.
      const account = BotSlackIconShownRecords.accountKey(cloud.signedInAccount?.())
      // The window draws a new look right after the write: until it does, Slack keeps the last drawing.
      left =
        parsed.kind === 'mascot' &&
        !icon &&
        shown?.account === account &&
        shown.mascot === parsed.id
      const result = left
        ? ({ ok: true } as const)
        : body && (await botsCloudClient(cloud).setAvatar(bot.id, body))
      sent = result?.ok === true
      // Marked unless another account signed in during the send: which one took it is unknown then. A
      // sign-out or quit's fence (no account now) leaves the account the send went as.
      const now = BotSlackIconShownRecords.accountKey(cloud.signedInAccount?.())
      if (sent && !left && (now === null || now === account)) {
        this.shown.mark(
          bot.id,
          carried && parsed.kind === 'mascot' ? { account, mascot: parsed.id } : null
        )
      }
      refused = result?.ok === false && result.error === 'unknown_bot'
    } catch (error) {
      console.error('Failed to send the bot’s picture to the cloud:', error)
    }
    this.sending.delete(bot.id)
    // A drawing's bytes are held only while its send is out; whatever comes next reads them again.
    if (carried) {
      this.prepared.delete(bot.id)
    }
    // A bot write or a new drawing came in while this one was on its way.
    const stepped = writes !== this.writes || icons !== this.icons.get(bot.id)
    if (sent && icons !== this.icons.get(bot.id)) {
      // An icon was kept after this send read none: it goes next.
      this.sent.delete(bot.id)
      this.changedWhileSending.delete(bot.id)
      this.resend(bot.id)
    } else if (sent) {
      this.owed.delete(bot.id)
      this.sent.set(bot.id, avatar)
      // Kept only for a retry: once taken, its bytes are let go.
      this.prepared.delete(bot.id)
      // The picture may have changed while this one was on its way: only then is the roster read again.
      // While bots are off, turning them on reads it again.
      // Not a real step for other bots: ones owed a drawing keep waiting for theirs.
      if (this.changedWhileSending.delete(bot.id) && this.deps.bots.enabled()) {
        this.pass(true)
      }
    } else if (refused && stepped) {
      // A bot write meanwhile may have registered it, or changed its picture: that write's own pass skipped
      // this bot while it was in flight, so only this bot goes again.
      this.resend(bot.id)
    } else if (refused && carried) {
      // The cloud doesn't know this bot yet, and the picture is a drawing: its bytes wait for a real step
      // (the write that links the bot is one) rather than going again on the backoff timer.
      this.owed.add(bot.id, true)
    } else if (refused) {
      // The cloud doesn't know this bot: it is asked again less and less often, or after a write.
      const before = this.refused.get(bot.id)
      const waitMs = Math.min(
        before?.avatar === avatar ? before.waitMs * 2 : RETRY_MS,
        MAX_REFUSED_WAIT_MS
      )
      this.refused.set(bot.id, { avatar, waitMs, until: Date.now() + waitMs })
      this.retryLater()
    } else {
      // The cloud may have taken it before the answer was lost: what it holds is unknown.
      this.sent.delete(bot.id)
      // A real step that came in meanwhile still gets its try for this bot (its own pass skipped it in
      // flight); other bots already had theirs.
      if (stepped || recoveries !== this.recoveries) {
        this.resend(bot.id)
      } else if (carried) {
        this.owed.add(bot.id)
      } else {
        this.retryLater()
      }
    }
    this.changedWhileSending.delete(bot.id)
    this.pump()
  }

  // The drawn icon for the mascot's look now, named by its bytes as an upload is; null sends the mascot
  // id. Kept per bot while its send is out; a missing one is kept until its look or icon changes.
  private async mascotIcon(bot: SyncedBot): Promise<{ version: string; png: string } | null> {
    const look = lookOf(bot)
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
    // A missing one is kept as missing too: an icon stored for it bumps the count, so it is read again then.
    this.prepared.set(bot.id, { look, icons, icon })
    return icon
  }
}
