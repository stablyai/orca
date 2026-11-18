// MEMORY.md as Orca last recorded it, per bot. A chat's turn end puts back what a write lost against
// it; a change through here (Settings, Forget, Undo) is the one way a fact leaves it. Every change to
// the record runs as one step on the bot's queue, and lands in the bot's memory history.
import { join } from 'node:path'
import {
  applyBotMemoryChange,
  type BotMemoryChange,
  botMemoryChange,
  botMemoryFactKeys,
  botMemoryLineKey,
  dropBotMemoryFact,
  isEmptyBotMemoryChange,
  mergeBotMemoryChanges,
  tagBotMemoryChanges
} from '../../shared/bot-memory-lines'
import type { BotMemoryAuthor } from '../../shared/bots/bot-memory-history'
import type { BotHomeFilesystem } from './bot-home'
import {
  type BotMemoryHistory,
  createBotMemoryHistory,
  NO_BOT_MEMORY_HISTORY
} from './bot-memory-history'

const REWRITE_ATTEMPTS = 3
const NO_CHANGE: BotMemoryChange = { added: [], removed: [] }

/** Null: not known yet, so a turn end takes everything in the file as new. `version` counts the
 *  record's changes; `writers` holds the last one each chat made ('' for any other writer). */
type Recorded = {
  text: string | null
  settled: Promise<unknown>
  version: number
  writers: Map<string, number>
}

const unknownRecord = (text: string | null): Recorded => ({
  text,
  settled: Promise.resolve(),
  version: 0,
  writers: new Map()
})

export type BotMemoryRecord = ReturnType<typeof createBotMemoryRecord>

export function createBotMemoryRecord(
  fs: Pick<BotHomeFilesystem, 'readText' | 'replaceText' | 'writeText'>,
  history: BotMemoryHistory = NO_BOT_MEMORY_HISTORY
) {
  const bots = new Map<string, Recorded>()

  /** Runs `step` after the bot's earlier steps; what it returns is recorded, undefined keeps the
   *  record, as written by chat `by` (absent: anyone else). Rejects with the step's error,
   *  recording nothing. */
  const after = async (
    botId: string,
    step: (text: string | null) => Promise<string | null | undefined>,
    by?: string
  ): Promise<void> => {
    let entry = bots.get(botId)
    if (!entry) {
      entry = unknownRecord(null)
      bots.set(botId, entry)
    }
    const recorded = entry
    const run = recorded.settled.then(async () => {
      const text = await step(recorded.text)
      if (text !== undefined && text !== recorded.text) {
        recorded.text = text
        recorded.version += 1
        recorded.writers.set(by ?? '', recorded.version)
      }
    })
    recorded.settled = run.catch(() => {})
    await run
  }

  /** A history row for `change`, queued now so later reads see it; a history that can't be
   *  written never fails the change. */
  const noted = (botId: string, by: BotMemoryAuthor, made: BotMemoryChange): void => {
    void history.append(botId, by, made)
  }

  /**
   * Makes the change `make` asks for on MEMORY.md as it is now and on the record (which starts
   * from the file when not known yet), as one step and one history row; what the file and the
   * record took. A missing file starts empty and is created only while still missing. Throws when
   * the file can't be read, every guarded write lost, `make` throws, or `beforeWrite` (given what
   * the file will lose and gain, and run again on a retry) throws: MEMORY.md is then unchanged.
   */
  const change = async (
    botId: string,
    folder: string,
    by: BotMemoryAuthor,
    make: (file: string, record: string | null) => BotMemoryChange | Promise<BotMemoryChange>,
    beforeWrite?: (made: BotMemoryChange) => Promise<void>
  ): Promise<BotMemoryChange> => {
    const path = join(folder, 'MEMORY.md')
    let made = NO_CHANGE
    await after(
      botId,
      async (text) => {
        let unreadable = false
        for (let attempt = 0; attempt < REWRITE_ATTEMPTS; attempt += 1) {
          const current = await fs.readText(path)
          const base = current ?? ''
          const asked = await make(base, text)
          const next = applyBotMemoryChange(base, asked)
          const recorded = text === null ? next : applyBotMemoryChange(text, asked)
          unreadable = current === null
          await beforeWrite?.(botMemoryChange(base, next))
          const wrote =
            current === null
              ? await fs.writeText(path, next, { exclusive: true })
              : next === current || (await fs.replaceText(path, current, next))
          if (wrote) {
            made = mergeBotMemoryChanges(
              botMemoryChange(base, next),
              text === null ? NO_CHANGE : botMemoryChange(text, recorded)
            )
            noted(botId, by, made)
            return recorded
          }
        }
        throw new Error(
          unreadable
            ? 'Could not read MEMORY.md; try again.'
            : 'MEMORY.md kept changing; try again.'
        )
      },
      by.kind === 'bot' ? by.sessionId : undefined
    )
    return made
  }

  return {
    /** What a launch read, while the record is not known yet. A change still running replaces it
     *  with the file it confirmed, so this earlier read can't undo it. */
    started: (botId: string, text: string | null): void => {
      const entry = bots.get(botId)
      if (entry) {
        entry.text ??= text
      } else {
        bots.set(botId, unknownRecord(text))
      }
    },
    /** How many times the record has changed, while a step may still be running. */
    version: (botId: string): number => bots.get(botId)?.version ?? 0,
    /** Whether a writer other than chat `sessionId` changed the record after `version`. */
    changedBesides: (botId: string, sessionId: string, version: number): boolean =>
      [...(bots.get(botId)?.writers ?? [])].some(
        ([writer, last]) => writer !== sessionId && last > version
      ),
    after,
    change,
    noted,
    history: (botId: string) => history.list(botId),
    undoneKnown: (botId: string, rowId: string) => history.undoneKnown(botId, rowId),
    whenUndoneKnown: (botId: string, then: () => void) => history.whenUndoneKnown(botId, then),
    /** Every history write queued so far, landed; for quit. */
    historySettled: () => history.settled(),
    /** Takes `fact` out of MEMORY.md and the record; false when neither had it. */
    forget: async (
      botId: string,
      folder: string,
      fact: string,
      by: BotMemoryAuthor
    ): Promise<boolean> => {
      const made = await change(botId, folder, by, (file, record) => ({
        added: [],
        removed: [file, record ?? ''].flatMap(
          (text) => botMemoryChange(text, dropBotMemoryFact(text, fact).text).removed
        )
      }))
      return made.removed.length > 0
    },
    /** Puts back what history row `id` changed, leaving alone any fact a later change touched or
     *  that is gone; false when nothing was left to undo. */
    undo: async (botId: string, folder: string, id: string): Promise<boolean> => {
      const made = await change(botId, folder, { kind: 'undo', of: id }, async (file, record) => {
        // Read on the bot's queue, so the changes queued ahead of this Undo count as later.
        const rows = await history.list(botId)
        const index = rows.findIndex((entry) => entry.id === id)
        const row = rows[index]
        if (!row?.undoable) {
          throw new Error('This change can’t be undone.')
        }
        const later = new Set(
          rows
            .slice(0, index)
            .flatMap(({ change: { added, removed } }) =>
              [...added, ...removed].map(botMemoryLineKey)
            )
        )
        const present = new Set([...botMemoryFactKeys(file), ...botMemoryFactKeys(record ?? '')])
        const live = row.change.added.filter(
          (line) => present.has(botMemoryLineKey(line) ?? '') && !later.has(botMemoryLineKey(line))
        )
        // An edit whose new words were changed since or are gone was superseded: the old words
        // stay out.
        const superseded = live.length < row.change.added.length
        return {
          added: superseded
            ? []
            : row.change.removed.filter((line) => !later.has(botMemoryLineKey(line))),
          removed: live
        }
      })
      return !isEmptyBotMemoryChange(made)
    },
    removed: (botId: string): void => {
      bots.delete(botId)
      history.removed(botId).catch((error: unknown) => {
        console.warn('[bots] memory history not removed', error)
      })
    }
  }
}

/** A chat's turn end: puts back the facts a write lost since the record's `before` (a fact leaves
 *  only through a change the record makes) and marks those written, onto the file only as it still
 *  is; what it put back. Null when it can't read the file or every try lost to another write, so the
 *  record stays and the next turn end tries again. */
export async function tagBotMemoryFile(
  fs: Pick<BotHomeFilesystem, 'readText' | 'replaceText'>,
  folder: string,
  before: string,
  /** Read only when the file has a fact `before` lacks: the only line a label marks. */
  label: () => Promise<string | null>
): Promise<{ text: string; kept: BotMemoryChange } | null> {
  const path = join(folder, 'MEMORY.md')
  for (let attempt = 0; attempt < REWRITE_ATTEMPTS; attempt += 1) {
    const current = await fs.readText(path)
    if (current === null) {
      return null
    }
    const lost = botMemoryChange(before, current).removed
    const kept = applyBotMemoryChange(current, { added: lost, removed: [] })
    const added = botMemoryChange(before, kept).added.length > 0
    const tagged = tagBotMemoryChanges(before, kept, added ? await label() : null)
    if (tagged === current || (await fs.replaceText(path, current, tagged))) {
      return { text: tagged, kept: botMemoryChange(current, kept) }
    }
  }
  return null
}

/** The host's record, with history in Orca's data folder. */
export function hostBotMemoryRecord(
  fs: Pick<BotHomeFilesystem, 'readText' | 'replaceText' | 'writeText'>
): BotMemoryRecord {
  return createBotMemoryRecord(fs, createBotMemoryHistory())
}
