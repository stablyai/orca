// The skills a Share dialog lists, read once per dialog and kept for its picks. A tick changes what is
// packed, never what is listed, so a pick reuses the listing its own dialog last read of the same
// sources (the bot's agent, home and linked projects) instead of walking every skill folder again.
// Each dialog has its own session: nothing is shared with, or stopped for, another dialog.
import { BOT_SHARE_ERRORS } from '../../../shared/bots/bot-share-errors'
import type { BotShareLeftOut } from '../../../shared/bots/bot-package'
import type { BotShareSkill } from './bot-share-skills'

export type BotShareSkillListing = {
  skills: BotShareSkill[]
  /** The skills left out, and why, in the order the read found them. */
  leftOut: BotShareLeftOut[]
  /** A project folder moved or went missing while it was read: this listing is never kept. */
  moved?: boolean
}

/** How a build lists the skills. Without a `session`, every build reads them afresh; with
 *  `reuseSkills` (only the picks changed), it lists what that dialog's last read listed. */
export type BotShareSkillsRead = {
  skillReads?: BotShareSkillReads
  session?: string
  reuseSkills?: boolean
  /** A build's (or pick's) place among its dialog's builds, taken when it was asked for. */
  build?: number
}

/** The key a bot's dialog keeps its reads under. */
export function skillsSessionKey(botId: string, session: string): string {
  return `${botId}/${session}`
}

type Read = {
  sources: string
  listing: Promise<BotShareSkillListing>
  controller: AbortController
}

/** A dialog's newest build or pick, its newest fresh build, and how many of its calls are running. */
type Order = { asked: number; fresh: number; running: number }

/** How many dialogs' listings are kept; an older dialog's next pick just reads again. */
const SESSIONS_KEPT = 8

export class BotShareSkillReads {
  /** Each recent dialog's latest read, oldest first. */
  private readonly latest = new Map<string, Read>()
  /** Each recent dialog's order, oldest first. A dialog with a call running is never dropped, so
   *  which call is newer is known for as long as any of them can still read. */
  private readonly order = new Map<string, Order>()
  private builds = 0

  /** How a build for this bot's dialog (`session`) and pick (`reuseSkills`) reads through these
   *  reads. Call it when the build is asked for, before anything it awaits, and `release` it once
   *  done: each build and pick takes its place in the dialog then, so the newer one wins however
   *  long each one's lookups take. */
  forBuild(botId: string, { session, reuseSkills }: BotShareSkillsRead): BotShareSkillsRead {
    const build = ++this.builds
    if (!session) {
      return { skillReads: this, session, reuseSkills, build }
    }
    const key = skillsSessionKey(botId, session)
    const order = this.order.get(key) ?? { asked: 0, fresh: 0, running: 0 }
    order.asked = build
    order.fresh = reuseSkills ? order.fresh : build
    order.running += 1
    this.order.delete(key)
    this.order.set(key, order)
    this.dropIdleOrders()
    return { skillReads: this, session, reuseSkills, build }
  }

  /** Runs a build or pick `forBuild` places at once, releasing its place however it ends. */
  async placed<T>(
    botId: string,
    read: BotShareSkillsRead,
    build: (skills: BotShareSkillsRead) => Promise<T>
  ): Promise<T> {
    const skills = this.forBuild(botId, read)
    try {
      return await build(skills)
    } finally {
      this.release(botId, skills)
    }
  }

  /** The end of a build `forBuild` placed, read or not. */
  release(botId: string, { session, build }: BotShareSkillsRead): void {
    const order = session && build !== undefined && this.order.get(skillsSessionKey(botId, session))
    if (order) {
      order.running -= 1
      this.dropIdleOrders()
    }
  }

  /** With `reuse`, the dialog's last listing of these sources, waiting for it while it is still
   *  being read. Otherwise, or when the sources changed, a fresh read that stops the dialog's older
   *  one. A build or pick older than one asked for since, that can't reuse, fails as `prepareAgain`
   *  without stopping or replacing anything; so does an older build once a newer fresh build is
   *  asked for, before it packs anything. `sources` null (a root that could not be resolved) is
   *  never reused or kept: it reads afresh. */
  read(
    session: string,
    sources: string | null,
    reuse: boolean,
    run: (signal: AbortSignal) => Promise<BotShareSkillListing>,
    build?: number
  ): Promise<BotShareSkillListing> {
    const last = this.latest.get(session)
    if (reuse && sources !== null && last?.sources === sources) {
      // Joined while it read and a folder moved meanwhile: not a listing to reuse, so read again.
      return this.settled(last).then((listing) =>
        listing.moved ? this.read(session, sources, reuse, run, build) : listing
      )
    }
    if (this.behind(session, build, 'asked')) {
      return Promise.reject(new Error(BOT_SHARE_ERRORS.prepareAgain))
    }
    const controller = new AbortController()
    if (sources === null) {
      // A fresh build still replaces the older listing; a pick leaves it for the next pick.
      if (!reuse && last) {
        last.controller.abort()
        this.latest.delete(session)
      }
      return this.settled(
        { sources: '', listing: run(controller.signal), controller },
        session,
        build
      )
    }
    last?.controller.abort()
    const entry: Read = { sources, listing: run(controller.signal), controller }
    keepRecent(this.latest, session, entry)
    const forget = () => {
      if (this.latest.get(session) === entry) {
        this.latest.delete(session)
      }
    }
    // A failed read, or one a folder moved under, is never reused: the next pick reads again.
    entry.listing.then((listing) => {
      if (listing.moved) {
        forget()
      }
    }, forget)
    return this.settled(entry, session, build)
  }

  /** Whether `build` is older than the dialog's newest call of that kind; a placed build whose
   *  dialog's order is gone can't show it is newest, so it counts as older. */
  private behind(session: string, build: number | undefined, kind: 'asked' | 'fresh'): boolean {
    return build !== undefined && build < (this.order.get(session)?.[kind] ?? Infinity)
  }

  private async settled(
    entry: Read,
    session?: string,
    build?: number
  ): Promise<BotShareSkillListing> {
    let listing: BotShareSkillListing
    try {
      listing = await entry.listing
    } catch (error) {
      throw entry.controller.signal.aborted ? new Error(BOT_SHARE_ERRORS.prepareAgain) : error
    }
    // A newer build was asked for while this one read: it replaces this one, which must not pack.
    if (session !== undefined && this.behind(session, build, 'fresh')) {
      throw new Error(BOT_SHARE_ERRORS.prepareAgain)
    }
    return listing
  }

  /** Drops the oldest idle dialogs' order beyond `SESSIONS_KEPT`. */
  private dropIdleOrders(): void {
    for (const [key, order] of this.order) {
      if (this.order.size <= SESSIONS_KEPT) {
        break
      }
      if (order.running <= 0) {
        this.order.delete(key)
      }
    }
  }
}

/** Records `place` as `key`'s newest; one older than the newest recorded fails as `prepareAgain`. */
export function claimNewest(
  newest: Map<string, number>,
  key: string,
  place: number | undefined
): void {
  if (place === undefined) {
    return
  }
  if (place < (newest.get(key) ?? 0)) {
    throw new Error(BOT_SHARE_ERRORS.prepareAgain)
  }
  newest.set(key, place)
}

/** Sets `key` as the newest entry, dropping the oldest beyond `SESSIONS_KEPT`. */
function keepRecent<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key)
  map.set(key, value)
  for (const oldest of map.keys()) {
    if (map.size <= SESSIONS_KEPT) {
      break
    }
    map.delete(oldest)
  }
}
