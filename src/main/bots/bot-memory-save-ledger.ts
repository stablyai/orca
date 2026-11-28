// Which bot chats already used their memory save for the current context window, kept on the host
// across restarts so a restart can never start a second save in the same window. Written only when
// an attempt is admitted or a measured drop re-arms a chat: a few times a week per busy bot.
import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import type { BotMemorySaveWindowState } from '../../shared/bots/bot-memory-save-window'

const LEDGER_FILE = 'bot-memory-save-windows.json'
/** Chats remembered; past this the oldest disarmed ones go, which only allows one extra save each. */
export const BOT_MEMORY_SAVE_LEDGER_LIMIT = 2_000

type Entry = { armed: boolean; at: number }

export type BotMemorySaveLedger = {
  /** Null while the file can't be read: then no save starts, so none can repeat. */
  read: (sessionId: string) => Promise<BotMemorySaveWindowState | null>
  write: (sessionId: string, state: BotMemorySaveWindowState) => Promise<void>
}

export type BotMemorySaveLedgerFile = {
  load: () => Promise<string | null>
  save: (text: string) => Promise<void>
}

const ledgerSchema = lazyZodSchema(() =>
  z.record(z.string(), z.object({ armed: z.boolean(), at: z.number() }))
)

function parse(text: string | null): Map<string, Entry> | null {
  if (text === null) {
    return new Map()
  }
  try {
    const parsed = ledgerSchema.safeParse(JSON.parse(text))
    return parsed.success ? new Map(Object.entries(parsed.data)) : null
  } catch {
    return null
  }
}

/** Read once, then kept in memory; every change is written through before it is acted on. */
export function createBotMemorySaveLedger(
  file: BotMemorySaveLedgerFile,
  now: () => number = Date.now
): BotMemorySaveLedger {
  let loaded: Promise<Map<string, Entry> | null> | null = null
  const entries = (): Promise<Map<string, Entry> | null> => {
    loaded ??= file
      .load()
      .then(parse)
      .catch(() => null)
    return loaded
  }
  let writes: Promise<void> = Promise.resolve()
  return {
    read: async (sessionId) => {
      const map = await entries()
      if (!map) {
        return null
      }
      const entry = map.get(sessionId)
      return { armed: entry?.armed ?? true }
    },
    write: async (sessionId, state) => {
      const map = await entries()
      if (!map) {
        throw new Error('bot_memory_save_ledger_unreadable')
      }
      map.delete(sessionId)
      map.set(sessionId, { armed: state.armed, at: now() })
      // Insertion order is age order: the oldest entries go first.
      for (const key of map.keys()) {
        if (map.size <= BOT_MEMORY_SAVE_LEDGER_LIMIT) {
          break
        }
        map.delete(key)
      }
      const text = JSON.stringify(Object.fromEntries(map))
      // In order, and one failed write never blocks the next.
      const write = writes.catch(() => {}).then(() => file.save(text))
      writes = write
      await write
    }
  }
}

/** Written beside the target and renamed over it, so a crash leaves the old file or the new one. */
async function writeAtomically(path: string, text: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export function botMemorySaveLedgerFile(userDataPath: string): BotMemorySaveLedgerFile {
  const path = join(userDataPath, LEDGER_FILE)
  return {
    load: async () => {
      try {
        return await readFile(path, 'utf8')
      } catch (error) {
        if (isMissingFile(error)) {
          return null
        }
        throw error
      }
    },
    save: (text) => writeAtomically(path, text)
  }
}
