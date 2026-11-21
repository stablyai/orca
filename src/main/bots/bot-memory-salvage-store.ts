// Each bot's salvage record on its host: every line the status move took out of MEMORY.md, by its
// hash, with where it stands. Kept beside the profile, not in the bot's home, so only a line Orca
// itself moved is ever offered back: a line written into a journal file by hand never is.
import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { SALVAGE, salvageLineDate, salvageLineHash } from './bot-memory-salvage'

export function salvageStoreFile(userDataPath: string): string {
  return join(userDataPath, 'bot-memory-salvage.json')
}

/** Where a moved line stands. `moved` is not looked at yet; the rest follow the design's states,
 *  and kept, kept-already-present, declined, unrestorable and non-candidate are final. */
export const SALVAGE_STATES = [
  'moved',
  'non-candidate',
  'candidate',
  'proposed',
  'kept',
  'kept-already-present',
  'declined',
  'unrestorable',
  'expired'
] as const

const SourceSchema = z.object({
  month: z.string(),
  line: z.string(),
  movedAt: z.number(),
  state: z.enum(SALVAGE_STATES),
  /** Proposals that expired with it listed. */
  expiries: z.number().default(0)
})

const BotSalvageSchema = z.object({ sources: z.record(z.string(), SourceSchema) })
const FileSchema = z.object({ bots: z.record(z.string(), BotSalvageSchema) })

export type SalvageSource = z.infer<typeof SourceSchema>
export type BotSalvage = z.infer<typeof BotSalvageSchema>

export type SalvageStoreIo = {
  read: () => Promise<string | null>
  write: (text: string) => Promise<void>
}

export function salvageFileIo(path: () => string): SalvageStoreIo {
  return {
    read: () => readFile(path(), 'utf8').catch(() => null),
    // A whole new file renamed over the old, so a crash leaves one or the other, never half.
    write: async (text) => {
      const temp = `${path()}.${randomUUID()}.tmp`
      await writeFile(temp, text, { mode: 0o600 })
      await rename(temp, path())
    }
  }
}

const EMPTY: BotSalvage = { sources: {} }

let hostStore: BotSalvageStore | null = null

/** This host's salvage record; the path resolves on first use, once the profile is known. */
export function hostSalvageStore(): BotSalvageStore {
  hostStore ??= new BotSalvageStore(salvageFileIo(() => salvageStoreFile(getProfileUserDataPath())))
  return hostStore
}

export class BotSalvageStore {
  private bots: Promise<Map<string, BotSalvage>> | null = null
  /** An unreadable file is never written over: what it held may be the only record of a move. */
  private readOnly = false
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly io: SalvageStoreIo) {}

  private all(): Promise<Map<string, BotSalvage>> {
    this.bots ??= this.io.read().then((text) => {
      let parsed: z.infer<typeof FileSchema> | null = null
      try {
        parsed = text ? FileSchema.parse(JSON.parse(text)) : null
      } catch (error) {
        this.readOnly = true
        console.warn('[bots] salvage record unreadable; leaving it as it is', error)
      }
      return new Map(Object.entries(parsed?.bots ?? {}))
    })
    return this.bots
  }

  async get(botId: string): Promise<BotSalvage> {
    return (await this.all()).get(botId) ?? EMPTY
  }

  /** Notes lines the status move took into `month`'s journal; a line already known keeps its
   *  state, so a line moved again after a restore is still the restored one. */
  async recordMoved(
    botId: string,
    month: string,
    lines: readonly string[],
    now: number
  ): Promise<void> {
    const all = await this.all()
    const sources = { ...(all.get(botId) ?? EMPTY).sources }
    let added = 0
    for (const line of lines) {
      const hash = salvageLineHash(month, line)
      if (!sources[hash]) {
        sources[hash] = { month, line: line.trimEnd(), movedAt: now, state: 'moved', expiries: 0 }
        added++
      }
    }
    if (added === 0 || this.readOnly) {
      return
    }
    all.set(botId, { sources })
    const text = JSON.stringify({ bots: Object.fromEntries(all) })
    // Saves in the order they were made; one that fails is said, and the next carries it.
    this.writing = this.writing.then(() => this.io.write(text))
    await this.writing.catch((error) => {
      this.writing = Promise.resolve()
      throw error
    })
  }
}

/**
 * The candidates the next proposal lists, by hash: those listed before and left unanswered first,
 * then the rest, each group oldest line first, so a backlog never starves what was offered once.
 */
export function salvageNextProposal(salvage: BotSalvage): string[] {
  const date = ([, source]: [string, SalvageSource]): string =>
    salvageLineDate(source.line) ?? source.month
  const waiting = Object.entries(salvage.sources).filter(
    ([, source]) =>
      source.state === 'candidate' ||
      (source.state === 'expired' && source.expiries < SALVAGE.expiriesFinal)
  )
  return waiting
    .toSorted(
      (a, b) =>
        Number(b[1].expiries > 0) - Number(a[1].expiries > 0) || date(a).localeCompare(date(b))
    )
    .slice(0, SALVAGE.perProposal)
    .map(([hash]) => hash)
}
