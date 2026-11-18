// Each bot's memory history, one file per bot in Orca's data folder: outside the bot's home, so the
// bot's own tools can't rewrite the record of what it changed.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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
import { writeFileAtomically } from '../filesystem/atomic-file-publication'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'

/** At most this many rows a bot, newest kept. */
const MAX_ROWS = 1_000
const DAY_MS = 24 * 60 * 60 * 1000
const FILE_SUFFIX = '.json'

export type BotMemoryHistoryIo = {
  read: (botId: string) => string | null
  /** Null text removes the bot's history. */
  write: (botId: string, text: string | null) => void
  /** Every bot with history. */
  bots: () => string[]
}

export type BotMemoryHistory = {
  /** Records `change` as one row; nothing for no change. */
  append: (botId: string, by: BotMemoryAuthor, change: BotMemoryChange) => void
  /** Newest first. */
  list: (botId: string) => BotMemoryHistoryRow[]
  /** The bot was deleted: its history goes too. */
  removed: (botId: string) => void
}

export const NO_BOT_MEMORY_HISTORY: BotMemoryHistory = {
  append: () => {},
  list: () => [],
  removed: () => {}
}

export function botMemoryHistoryFiles(
  folder = (): string => join(getProfileUserDataPath(), 'bot-memory-history')
): BotMemoryHistoryIo {
  const path = (botId: string): string =>
    join(folder(), `${encodeURIComponent(botId)}${FILE_SUFFIX}`)
  return {
    read: (botId) => {
      try {
        return readFileSync(path(botId), 'utf8')
      } catch {
        return null
      }
    },
    write: (botId, text) => {
      if (text === null) {
        rmSync(path(botId), { force: true })
        return
      }
      mkdirSync(folder(), { recursive: true })
      writeFileAtomically(path(botId), text, { mode: 0o600 })
    },
    bots: () => {
      try {
        return readdirSync(folder())
          .filter((name) => name.endsWith(FILE_SUFFIX))
          .map((name) => decodeURIComponent(name.slice(0, -FILE_SUFFIX.length)))
      } catch {
        return []
      }
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
  /** The bot's rows still within the limit; rows past it are deleted from disk too. */
  const read = (botId: string): BotMemoryHistoryRow[] => {
    const parsed = z.array(BotMemoryHistoryRowSchema).safeParse(parseJson(io.read(botId)))
    const all = parsed.success ? parsed.data : []
    const since = now() - BOT_MEMORY_HISTORY_DAYS * DAY_MS
    const rows = all.filter((row) => row.at >= since)
    if (rows.length < all.length) {
      io.write(botId, rows.length > 0 ? JSON.stringify(rows) : null)
    }
    return rows
  }
  // Bots no one opens still lose their old rows: the first use sweeps every bot's history.
  let swept = false
  const sweep = (): void => {
    if (!swept) {
      swept = true
      for (const botId of io.bots()) {
        read(botId)
      }
    }
  }
  return {
    list: (botId) => {
      sweep()
      return read(botId)
    },
    append: (botId, by, change) => {
      sweep()
      if (isEmptyBotMemoryChange(change)) {
        return
      }
      const row: BotMemoryHistoryRow = { id: randomUUID(), at: now(), ...redacted(by, change) }
      io.write(botId, JSON.stringify([row, ...read(botId)].slice(0, MAX_ROWS)))
    },
    removed: (botId) => io.write(botId, null)
  }
}
