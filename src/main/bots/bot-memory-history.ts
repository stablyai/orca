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
  /** Records `change` as one row, queued behind the bot's earlier history work; nothing for no change. */
  append: (botId: string, by: BotMemoryAuthor, change: BotMemoryChange) => Promise<void>
  /** Newest first, including every append made before this call. */
  list: (botId: string) => Promise<BotMemoryHistoryRow[]>
  /** The bot was deleted: its history goes too. */
  removed: (botId: string) => Promise<void>
  /** Everything queued so far has landed; for quit. */
  settled: () => Promise<void>
}

export const NO_BOT_MEMORY_HISTORY: BotMemoryHistory = {
  append: async () => {},
  list: async () => [],
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
  /** The bot's rows still within the limit; rows past it are deleted from disk too. Run queued. */
  const read = async (botId: string): Promise<BotMemoryHistoryRow[]> => {
    const parsed = z.array(BotMemoryHistoryRowSchema).safeParse(parseJson(await io.read(botId)))
    const all = parsed.success ? parsed.data : []
    const since = now() - BOT_MEMORY_HISTORY_DAYS * DAY_MS
    const rows = all.filter((row) => row.at >= since)
    if (rows.length < all.length) {
      await io.write(botId, rows.length > 0 ? JSON.stringify(rows) : null)
    }
    return rows
  }
  // Bots no one opens still lose their old rows: after the first use, every bot's history is
  // pruned in the background, one at a time behind that bot's own work.
  let sweep: Promise<void> | null = null
  const startSweep = (): void => {
    sweep ??= (async () => {
      for (const botId of await io.bots()) {
        await queued(botId, () => read(botId))
      }
    })().catch((error: unknown) => console.warn('[bots] memory history sweep failed', error))
  }
  const settled = async (): Promise<void> => {
    await sweep
    while (queues.size > 0) {
      await Promise.all(queues.values())
    }
  }
  return {
    list: (botId) => {
      const rows = queued(botId, () => read(botId))
      startSweep()
      return rows
    },
    append: (botId, by, change) => {
      if (isEmptyBotMemoryChange(change)) {
        startSweep()
        return Promise.resolve()
      }
      const row: BotMemoryHistoryRow = { id: randomUUID(), at: now(), ...redacted(by, change) }
      const appended = queued(botId, async () => {
        await io.write(botId, JSON.stringify([row, ...(await read(botId))].slice(0, MAX_ROWS)))
      })
      startSweep()
      return appended
    },
    removed: (botId) => {
      const removed = queued(botId, () => io.write(botId, null))
      startSweep()
      return removed
    },
    settled
  }
}
