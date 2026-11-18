// Each bot's look-around record on its host: runs, suggestions and the owner's Start and Dismiss.
// One file beside the profile, separate from the bot record, so a suggestion never rewrites a bot.
import { BotTidyUpSummarySchema } from '../../shared/bots/bot-tidy-up'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writeFileAtomically } from '../filesystem/atomic-file-publication'
import { SUGGESTION_SOURCES } from '../../shared/bots/bot-look-around'
import { backgroundRunSessionIds, EMPTY_BOT_LOOK, type BotLookState } from './bot-look-around-state'
import { lookFailureIsQuiet } from './bot-look-around-failures'
import { backgroundRunSlept } from './bot-background-run'

export function lookAroundStoreFile(userDataPath: string): string {
  return join(userDataPath, 'bot-look-around.json')
}

const SuggestionSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  why: z.string(),
  ask: z.string(),
  link: z.string().optional(),
  source: z.enum(SUGGESTION_SOURCES).optional().catch(undefined),
  createdAt: z.number(),
  runSessionId: z.string(),
  status: z.enum(['open', 'started', 'dismissed', 'replaced']),
  resolvedAt: z.number().optional()
})

const RunSchema = z.object({
  sessionId: z.string(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  error: z.string().optional(),
  alerted: z.literal(true).optional(),
  asleep: z.literal(true).optional()
})

const BotLookSchema = z.object({
  armedAt: z.number().optional(),
  runs: z.array(RunSchema),
  pastSessionIds: z.array(z.string()).optional(),
  suggestions: z.array(SuggestionSchema),
  // Absent in a record written before dismissals were kept apart.
  dismissals: z
    .array(
      z.object({
        title: z.string(),
        key: z.string().optional(),
        at: z.number()
      })
    )
    .default([]),
  seenAt: z.number().optional(),
  tidyUp: z
    .object({
      runs: z.array(RunSchema),
      pastSessionIds: z.array(z.string()).optional(),
      through: z.number().optional(),
      checkedAt: z.number().optional(),
      last: BotTidyUpSummarySchema.optional().catch(undefined)
    })
    .optional()
})

const FileSchema = z.object({ bots: z.record(z.string(), BotLookSchema) })

export type LookAroundStoreIo = {
  read: () => string | null
  write: (text: string) => Promise<void>
}

/** The path resolves on first use: the runtime is built before the profile directory is known. */
export function lookAroundFileIo(path: () => string): LookAroundStoreIo {
  return {
    read: () => {
      try {
        return readFileSync(path(), 'utf8')
      } catch {
        return null
      }
    },
    write: async (text) => {
      writeFileAtomically(path(), text, { mode: 0o600 })
    }
  }
}

export class BotLookAroundStore {
  private bots: Map<string, BotLookState> | null = null
  /** Each run's session to its bot; every chat read asks per session, so it is built once per change. */
  private runOwners: { look: Map<string, string>; tidyUp: Map<string, string> } | null = null
  private writing: Promise<void> = Promise.resolve()
  private saveQueued = false

  constructor(
    private readonly io: LookAroundStoreIo,
    /** Clients re-read Up next on this. */
    private readonly onChange: () => void
  ) {}

  private all(): Map<string, BotLookState> {
    if (!this.bots) {
      const text = this.io.read()
      let parsed: z.infer<typeof FileSchema> | null = null
      try {
        parsed = text ? FileSchema.parse(JSON.parse(text)) : null
      } catch (error) {
        // Unreadable: start again rather than block the bot; suggestions are cheap to make again.
        console.warn('[bots] look-around record unreadable; starting it again', error)
      }
      this.bots = new Map(Object.entries(parsed?.bots ?? {}))
    }
    return this.bots
  }

  get(botId: string): BotLookState {
    return this.all().get(botId) ?? EMPTY_BOT_LOOK
  }

  /** The bot whose look-around run this session is; null for any other session. */
  botOfLook(sessionId: string): string | null {
    return this.owners().look.get(sessionId) ?? null
  }

  /** The bot whose Tidy-up run this session is; null for any other session. */
  botOfTidyUp(sessionId: string): string | null {
    return this.owners().tidyUp.get(sessionId) ?? null
  }

  private owners(): { look: Map<string, string>; tidyUp: Map<string, string> } {
    if (!this.runOwners) {
      const look = new Map<string, string>()
      const tidyUp = new Map<string, string>()
      for (const [botId, state] of this.all()) {
        backgroundRunSessionIds(state).forEach((id) => look.set(id, botId))
        if (state.tidyUp) {
          backgroundRunSessionIds(state.tidyUp).forEach((id) => tidyUp.set(id, botId))
        }
      }
      this.runOwners = { look, tidyUp }
    }
    return this.runOwners
  }

  /** A look's or a tidy-up's turn is no news when it succeeds, whatever it ended with (its owner
   *  hears through Up next or memory History), when the host slept during it (it is missed and
   *  tried again), and when it fails under `lookFailureIsQuiet`; any other session's turn is news. */
  lookTurnIsQuiet(sessionId: string, outcome: 'success' | 'failure'): boolean {
    const look = this.botOfLook(sessionId)
    const tidy = look === null ? this.botOfTidyUp(sessionId) : null
    const runs = look !== null ? this.get(look) : tidy !== null ? this.get(tidy).tidyUp : undefined
    return (
      runs !== undefined &&
      (outcome === 'success' ||
        backgroundRunSlept(sessionId) ||
        lookFailureIsQuiet(runs, sessionId))
    )
  }

  /** Applies a change, saves it, and tells clients; unchanged state writes nothing. */
  update<T>(botId: string, change: (state: BotLookState) => { state: BotLookState; result: T }): T {
    const before = this.get(botId)
    const { state, result } = change(before)
    if (state !== before) {
      this.all().set(botId, state)
      this.runOwners = null
      this.save()
      this.onChange()
    }
    return result
  }

  forget(botId: string): void {
    if (this.all().delete(botId)) {
      this.runOwners = null
      this.save()
    }
  }

  /** Resolves once every change so far is on disk. */
  flushed(): Promise<void> {
    return this.writing
  }

  private save(): void {
    // A write already queued but not started serialises the latest state, so it covers this change.
    if (this.saveQueued) {
      return
    }
    this.saveQueued = true
    this.writing = this.writing
      .then(() => {
        this.saveQueued = false
        return this.io.write(JSON.stringify({ bots: Object.fromEntries(this.all()) }))
      })
      .catch((error: unknown) => console.warn('[bots] could not save look-around record', error))
  }
}
