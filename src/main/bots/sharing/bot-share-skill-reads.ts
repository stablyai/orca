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
  /** The place of the build or pick that read it; an older one never stops or replaces it. */
  build?: number
}

/** How many dialogs' listings are kept; an older dialog's next pick just reads again. */
const SESSIONS_KEPT = 8

export class BotShareSkillReads {
  /** Each recent dialog's latest read, oldest first. */
  private readonly latest = new Map<string, Read>()
  /** Each recent dialog's newest fresh build, oldest dialog first. */
  private readonly newest = new Map<string, number>()
  private builds = 0

  /** How a build for this bot's dialog (`session`) and pick (`reuseSkills`) reads through these
   *  reads. Call it when the build is asked for, before anything it awaits: each build and pick takes
   *  its place in the dialog then, so the newer one wins however long each one's lookups take. */
  forBuild(botId: string, { session, reuseSkills }: BotShareSkillsRead): BotShareSkillsRead {
    if (!session) {
      return { skillReads: this, session, reuseSkills }
    }
    const build = ++this.builds
    if (!reuseSkills) {
      keepRecent(this.newest, skillsSessionKey(botId, session), build)
    }
    return { skillReads: this, session, reuseSkills, build }
  }

  /** With `reuse`, the dialog's last listing of these sources, waiting for it while it is still
   *  being read. Otherwise, or when the sources changed, a fresh read that stops the dialog's older
   *  one. A replaced build (older than the dialog's newest fresh build, or than the listing kept)
   *  fails as `prepareAgain` before packing anything and never stops or replaces a newer read.
   *  `sources` null (a root that could not be resolved) is never reused or kept: it reads afresh. */
  read(
    session: string,
    sources: string | null,
    reuse: boolean,
    run: (signal: AbortSignal) => Promise<BotShareSkillListing>,
    build?: number
  ): Promise<BotShareSkillListing> {
    const last = this.latest.get(session)
    if (reuse && sources !== null && last?.sources === sources) {
      return this.settled(last)
    }
    if (
      this.replaced(session, build) ||
      (build !== undefined && last?.build !== undefined && build < last.build)
    ) {
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
    const entry: Read = { sources, listing: run(controller.signal), controller, build }
    keepRecent(this.latest, session, entry)
    // A failed read is never reused: the next pick reads again.
    entry.listing.catch(() => {
      if (this.latest.get(session) === entry) {
        this.latest.delete(session)
      }
    })
    return this.settled(entry, session, build)
  }

  private replaced(session: string, build: number | undefined): boolean {
    return build !== undefined && build < (this.newest.get(session) ?? build)
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
    if (session !== undefined && this.replaced(session, build)) {
      throw new Error(BOT_SHARE_ERRORS.prepareAgain)
    }
    return listing
  }
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
