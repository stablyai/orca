// Each bot's memory history, one file per bot in Orca's data folder: outside the bot's home, so the
// bot's own tools can't rewrite the record of what it changed.
import { randomUUID } from 'node:crypto'
import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  type BotMemoryChange,
  type BotMemoryLine,
  isEmptyBotMemoryChange
} from '../../shared/bot-memory-lines'
import {
  BOT_MEMORY_HISTORY_DAYS,
  type BotMemoryAuthor,
  type BotMemoryHistoryRow,
  BotMemoryHistoryRowSchema
} from '../../shared/bots/bot-memory-history'
import { redactSecretLike } from '../../shared/crash-reporting/crash-report-redaction'
import {
  removeStaleOwnerOnlyStaging,
  writeOwnerOnlyFileDurable
} from '../filesystem/owner-only-durable-file-write'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'

/** At most this many rows a bot, newest kept. */
const MAX_ROWS = 1_000
const DAY_MS = 24 * 60 * 60 * 1000
const FILE_SUFFIX = '.json'
// A history file's staged write, as durableWriteTempPath (and before it writeFileAtomically) names it.
const STAGED_FILE = /\.json\.\d+\.(\d+\.[0-9a-f]+|[0-9a-f-]{36})\.tmp$/

export type BotMemoryHistoryIo = {
  read: (botId: string) => Promise<string | null>
  /** Null text removes the bot's history. */
  write: (botId: string, text: string | null) => Promise<void>
  /** Every bot with history. */
  bots: () => Promise<string[]>
}

export type BotMemoryHistory = {
  /** Records `change` as one row, written behind the bot's earlier history work; nothing for no change.
   *  Never rejects: a failed write is logged once for every row it carried. */
  append: (botId: string, by: BotMemoryAuthor, change: BotMemoryChange) => Promise<void>
  /** Newest first, including every append made before this call. */
  list: (botId: string) => Promise<BotMemoryHistoryRow[]>
  /** Whether a row of the bot's history undoes row `rowId`, from memory; undefined until the bot's
   *  history was first read. */
  undoneKnown: (botId: string, rowId: string) => boolean | undefined
  /** Reads the bot's history once if `undoneKnown` can't answer yet, then calls `then` (the latest one
   *  asked for, per bot); nothing when it already can. */
  whenUndoneKnown: (botId: string, then: () => void) => void
  /** The bot was deleted: its history goes too. */
  removed: (botId: string) => Promise<void>
  /** Everything queued so far has landed; for quit. */
  settled: () => Promise<void>
}

export const NO_BOT_MEMORY_HISTORY: BotMemoryHistory = {
  append: async () => {},
  list: async () => [],
  undoneKnown: () => false,
  whenUndoneKnown: () => {},
  removed: async () => {},
  settled: async () => {}
}

export function botMemoryHistoryFiles(
  folder = (): string => join(getProfileUserDataPath(), 'bot-memory-history')
): BotMemoryHistoryIo {
  const path = (botId: string): string =>
    join(folder(), `${encodeURIComponent(botId)}${FILE_SUFFIX}`)
  return {
    read: async (botId) => {
      try {
        return await readFile(path(botId), 'utf8')
      } catch {
        return null
      }
    },
    write: async (botId, text) => {
      if (text === null) {
        await rm(path(botId), { force: true })
        return
      }
      await writeOwnerOnlyFileDurable(path(botId), text)
    },
    bots: async () => {
      let names: string[]
      try {
        names = await readdir(folder())
      } catch {
        return []
      }
      // Asked once a process: also takes what a quit cut off mid-write staged, but never this process's.
      const ownTemp = `${FILE_SUFFIX}.${process.pid}.`
      await Promise.all([
        ...names
          .filter((name) => STAGED_FILE.test(name) && !name.includes(ownTemp))
          .map((name) => rm(join(folder(), name), { force: true }).catch(() => {})),
        removeStaleOwnerOnlyStaging(folder())
      ])
      return names
        .filter((name) => name.endsWith(FILE_SUFFIX))
        .map((name) => decodeURIComponent(name.slice(0, -FILE_SUFFIX.length)))
    }
  }
}

/** A row keeps nothing secret-looking: such lines are redacted, and then can't be undone. */
function redacted(
  by: BotMemoryAuthor,
  change: BotMemoryChange
): Pick<BotMemoryHistoryRow, 'by' | 'change' | 'undoable'> {
  const clean = ({ line, after }: BotMemoryLine): BotMemoryLine => ({
    line: redactSecretLike(line),
    after: after === null ? null : redactSecretLike(after)
  })
  const kept = { added: change.added.map(clean), removed: change.removed.map(clean) }
  return {
    by: by.kind === 'chat' && by.source ? { ...by, source: redactSecretLike(by.source) } : by,
    change: kept,
    undoable: JSON.stringify(kept) === JSON.stringify(change)
  }
}

function parseJson(text: string | null): unknown {
  try {
    return JSON.parse(text ?? '[]')
  } catch {
    return []
  }
}

export function createBotMemoryHistory(
  io: BotMemoryHistoryIo = botMemoryHistoryFiles(),
  now: () => number = Date.now
): BotMemoryHistory {
  // Each bot's reads and writes run one at a time, in the order asked, off the main thread.
  const queues = new Map<string, Promise<unknown>>()
  const queued = <T>(botId: string, task: () => Promise<T>): Promise<T> => {
    const run = (queues.get(botId) ?? Promise.resolve()).then(task)
    const tail = run.catch(() => {})
    queues.set(botId, tail)
    void tail.then(() => {
      if (queues.get(botId) === tail) {
        queues.delete(botId)
      }
    })
    return run
  }
  const kept = (row: BotMemoryHistoryRow): boolean =>
    row.at >= now() - BOT_MEMORY_HISTORY_DAYS * DAY_MS
  /** The bot's rows still within the limit; rows past it are deleted from disk too. Run queued. */
  const read = async (botId: string): Promise<BotMemoryHistoryRow[]> => {
    const parsed = z.array(BotMemoryHistoryRowSchema).safeParse(parseJson(await io.read(botId)))
    const all = parsed.success ? parsed.data : []
    const rows = all.filter(kept)
    if (rows.length < all.length) {
      await io.write(botId, rows.length > 0 ? JSON.stringify(rows) : null)
    }
    return rows
  }
  // Per bot, the rows its undo rows point at, kept from its first read on so asking needs no disk.
  // A removal drops it, again once its turn comes, after every read queued before it.
  const undoneRows = new Map<string, Set<string>>()
  // Per bot, at most one read building it for someone waiting to hear, and who that is.
  const undoneLoads = new Map<string, () => void>()
  const undoTargets = (rows: readonly BotMemoryHistoryRow[]): Set<string> =>
    new Set(rows.flatMap((row) => (row.by.kind === 'undo' ? [row.by.of] : [])))
  // Per bot, at most one queued write and one queued read, however slow the disk: rows not yet written
  // wait here (newest first, at most MAX_ROWS) and reads add them to what the file holds.
  const pending = new Map<
    string,
    {
      unwritten: BotMemoryHistoryRow[]
      write: Promise<void> | null
      list: Promise<BotMemoryHistoryRow[]> | null
    }
  >()
  const pendingFor = (botId: string) => {
    let state = pending.get(botId)
    if (!state) {
      state = { unwritten: [], write: null, list: null }
      pending.set(botId, state)
    }
    return state
  }
  const forget = (botId: string): void => {
    const state = pending.get(botId)
    if (state && !state.write && !state.list && state.unwritten.length === 0) {
      pending.delete(botId)
    }
  }
  const write = (botId: string): Promise<void> => {
    const state = pendingFor(botId)
    state.write ??= queued(botId, async () => {
      state.write = null
      const rows = state.unwritten
      state.unwritten = []
      if (rows.length > 0) {
        const written = [...rows, ...(await read(botId))].slice(0, MAX_ROWS)
        await io.write(botId, JSON.stringify(written))
        // What retention or the row cap dropped no longer counts as undone.
        // Rows queued meanwhile may sit in a newer pending state once this one was forgotten.
        if (undoneRows.has(botId)) {
          const queuedSince = pending.get(botId)?.unwritten ?? []
          undoneRows.set(botId, undoTargets([...queuedSince, ...written]))
        }
      }
    })
      .catch((error: unknown) => console.warn('[bots] memory history not written', error))
      .finally(() => forget(botId))
    return state.write
  }
  // Bots no one opens still lose their old rows: after the first use, every bot's history is
  // pruned in the background, one at a time behind that bot's own work.
  let sweep: Promise<void> | null = null
  const startSweep = (): void => {
    sweep ??= (async () => {
      for (const botId of await io.bots()) {
        // One bot's unreadable file never keeps the others' old rows.
        await queued(botId, () => read(botId)).catch((error: unknown) =>
          console.warn('[bots] memory history not pruned', error)
        )
      }
    })().catch((error: unknown) => console.warn('[bots] memory history sweep failed', error))
  }
  const settled = async (): Promise<void> => {
    await sweep
    while (queues.size > 0) {
      await Promise.all(queues.values())
    }
  }
  const history: BotMemoryHistory = {
    list: (botId) => {
      const state = pendingFor(botId)
      state.list ??= queued(botId, async () => {
        state.list = null
        const rows = await read(botId)
        const unwritten = pending.get(botId)?.unwritten ?? []
        const listed = [...unwritten.filter(kept), ...rows].slice(0, MAX_ROWS)
        undoneRows.set(botId, undoTargets(listed))
        return listed
      }).finally(() => forget(botId))
      startSweep()
      return state.list
    },
    append: (botId, by, change) => {
      if (isEmptyBotMemoryChange(change)) {
        startSweep()
        return Promise.resolve()
      }
      const row: BotMemoryHistoryRow = { id: randomUUID(), at: now(), ...redacted(by, change) }
      const state = pendingFor(botId)
      state.unwritten = [row, ...state.unwritten].slice(0, MAX_ROWS)
      if (row.by.kind === 'undo') {
        undoneRows.get(botId)?.add(row.by.of)
      }
      const written = write(botId)
      startSweep()
      return written
    },
    removed: (botId) => {
      // What was queued before the removal keeps its own state; anything after starts afresh behind it.
      undoneRows.delete(botId)
      undoneLoads.delete(botId)
      const before = pending.get(botId)
      if (before) {
        before.unwritten = []
        pending.delete(botId)
      }
      const removed = queued(botId, async () => {
        undoneRows.delete(botId)
        await io.write(botId, null)
      }).finally(() => forget(botId))
      startSweep()
      return removed
    },
    undoneKnown: (botId, rowId) => undoneRows.get(botId)?.has(rowId),
    whenUndoneKnown: (botId, then) => {
      if (undoneRows.has(botId)) {
        return
      }
      const loading = undoneLoads.has(botId)
      undoneLoads.set(botId, then)
      if (loading) {
        return
      }
      history.list(botId).then(
        () => {
          const loaded = undoneLoads.get(botId)
          undoneLoads.delete(botId)
          loaded?.()
        },
        (error: unknown) => {
          undoneLoads.delete(botId)
          console.warn('[bots] memory history not read', error)
        }
      )
    },
    settled
  }
  return history
}
