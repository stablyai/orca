// The skills a bot's Share dialog lists, read once per dialog and kept for its picks. A tick changes
// what is packed, never what is listed, so a pick reuses the last listing of the same sources (the
// bot's agent, home and linked projects) instead of walking every skill folder again. The first build
// and a rebuild read afresh, and a fresh read stops the one it replaces.
import type { BotShareLeftOut } from '../../../shared/bots/bot-package'
import type { BotShareSkill } from './bot-share-skills'

export type BotShareSkillListing = {
  skills: BotShareSkill[]
  /** The skills left out, and why, in the order the read found them. */
  leftOut: BotShareLeftOut[]
}

/** How a build lists the skills. Without `skillReads`, every build reads them afresh; with
 *  `reuseSkills` (only the picks changed), it lists what the dialog's last build listed. */
export type BotShareSkillsRead = { skillReads?: BotShareSkillReads; reuseSkills?: boolean }

type Read = {
  sources: string
  listing: Promise<BotShareSkillListing>
  controller: AbortController
}

export class BotShareSkillReads {
  /** Each bot's latest read; one small listing per bot. */
  private readonly latest = new Map<string, Read>()

  /** With `reuse`, the bot's last listing of these sources, waiting for it while it is still being
   *  read. Otherwise, or when the sources changed, a fresh read that stops any older one; whoever
   *  waits on that older read gets the fresh listing, never an error. */
  read(
    botId: string,
    sources: string,
    reuse: boolean,
    run: (signal: AbortSignal) => Promise<BotShareSkillListing>
  ): Promise<BotShareSkillListing> {
    const last = this.latest.get(botId)
    if (reuse && last?.sources === sources) {
      return this.settled(botId, last)
    }
    last?.controller.abort()
    const controller = new AbortController()
    const entry: Read = { sources, listing: run(controller.signal), controller }
    this.latest.set(botId, entry)
    // A failed read is never reused: the next pick reads again.
    entry.listing.catch(() => {
      if (this.latest.get(botId) === entry) {
        this.latest.delete(botId)
      }
    })
    return this.settled(botId, entry)
  }

  private async settled(botId: string, entry: Read): Promise<BotShareSkillListing> {
    try {
      return await entry.listing
    } catch (error) {
      const newer = this.latest.get(botId)
      if (entry.controller.signal.aborted && newer && newer !== entry) {
        return this.settled(botId, newer)
      }
      throw error
    }
  }
}
