// Each bot's last published picks and setup note, on the host that publishes it. One file beside the
// profile, so publishing never rewrites the bot record.
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { writeFileAtomically } from '../../filesystem/atomic-file-publication'
import { BotSharePicksSchema, type BotSharePicks } from '../../../shared/bots/bot-share-picks'

const FileSchema = z.object({
  bots: z.record(z.string(), BotSharePicksSchema.optional().catch(undefined))
})

export class BotSharePicksStore {
  private writes: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: string) {}

  async get(botId: string): Promise<BotSharePicks | null> {
    return (await this.read())[botId] ?? null
  }

  set(botId: string, picks: BotSharePicks): Promise<void> {
    return this.change((bots) => ({ ...bots, [botId]: picks }))
  }

  /** After Stop sharing or a delete: the next publish starts from the defaults (memory off). */
  forget(botId: string): Promise<void> {
    return this.change((bots) => {
      if (!(botId in bots)) {
        return bots
      }
      const { [botId]: _gone, ...rest } = bots
      return rest
    })
  }

  private change(
    next: (bots: Record<string, BotSharePicks>) => Record<string, BotSharePicks>
  ): Promise<void> {
    const write = this.writes.then(async () => {
      const bots = await this.read()
      const updated = next(bots)
      if (updated !== bots) {
        writeFileAtomically(this.file, JSON.stringify({ bots: updated }))
      }
    })
    this.writes = write.catch(() => undefined)
    return write
  }

  /** An unreadable or malformed file reads as no picks: Update link then starts from the defaults. */
  private async read(): Promise<Record<string, BotSharePicks>> {
    const text = await readFile(this.file, 'utf8').catch(() => null)
    if (text === null) {
      return {}
    }
    try {
      const parsed = FileSchema.safeParse(JSON.parse(text))
      if (!parsed.success) {
        return {}
      }
      return Object.fromEntries(
        Object.entries(parsed.data.bots).filter((entry): entry is [string, BotSharePicks] =>
          Boolean(entry[1])
        )
      )
    } catch {
      return {}
    }
  }
}
