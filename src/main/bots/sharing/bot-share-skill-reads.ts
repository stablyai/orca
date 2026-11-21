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
}

type Read = {
  sources: string
  listing: Promise<BotShareSkillListing>
  controller: AbortController
}

/** How many dialogs' listings are kept; an older dialog's next pick just reads again. */
const SESSIONS_KEPT = 8

export class BotShareSkillReads {
  /** Each recent dialog's latest read, oldest first. */
  private readonly latest = new Map<string, Read>()

  /** How a build for this dialog (`session`) and pick (`reuseSkills`) reads through these reads. */
  forBuild({ session, reuseSkills }: BotShareSkillsRead): BotShareSkillsRead {
    return { skillReads: this, session, reuseSkills }
  }

  /** With `reuse`, the dialog's last listing of these sources, waiting for it while it is still
   *  being read. Otherwise, or when the sources changed, a fresh read that stops the dialog's older
   *  one: that build was replaced, so it fails as `prepareAgain` before packing anything. */
  read(
    session: string,
    sources: string,
    reuse: boolean,
    run: (signal: AbortSignal) => Promise<BotShareSkillListing>
  ): Promise<BotShareSkillListing> {
    const last = this.latest.get(session)
    if (reuse && last?.sources === sources) {
      return this.settled(last)
    }
    last?.controller.abort()
    const controller = new AbortController()
    const entry: Read = { sources, listing: run(controller.signal), controller }
    this.latest.delete(session)
    this.latest.set(session, entry)
    for (const oldest of this.latest.keys()) {
      if (this.latest.size <= SESSIONS_KEPT) {
        break
      }
      this.latest.delete(oldest)
    }
    // A failed read is never reused: the next pick reads again.
    entry.listing.catch(() => {
      if (this.latest.get(session) === entry) {
        this.latest.delete(session)
      }
    })
    return this.settled(entry)
  }

  private async settled(entry: Read): Promise<BotShareSkillListing> {
    try {
      return await entry.listing
    } catch (error) {
      throw entry.controller.signal.aborted ? new Error(BOT_SHARE_ERRORS.prepareAgain) : error
    }
  }
}
