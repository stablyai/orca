// What outlives a restart for chats that close themselves: Keep open, against the item set it was
// pressed for, and which chats Orca closed (so their rows reopen in place). One file beside the profile,
// read once and written in order, off the main thread's critical path.
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

export function botChatAutoCloseMarksFile(userDataPath: string): string {
  return join(userDataPath, 'bot-chat-auto-close.json')
}

const MarksSchema = z.object({
  kept: z.record(z.string(), z.string()).catch({}),
  closed: z.record(z.string(), z.number()).catch({})
})

type Marks = z.infer<typeof MarksSchema>

/** Past this many of each, the oldest go first. */
const MARKS_MAX = 500

export type BotChatAutoCloseMarksIo = {
  read: () => Promise<string | null>
  write: (text: string) => Promise<void>
}

/** The path resolves on first use: the runtime is built before the profile directory is known. */
export function botChatAutoCloseMarksFileIo(path: () => string): BotChatAutoCloseMarksIo {
  return {
    read: async () => {
      try {
        return await readFile(path(), 'utf8')
      } catch {
        return null
      }
    },
    // Whole or not at all: a crash mid-write leaves the last file.
    write: async (text) => {
      const target = path()
      const staged = `${target}.${process.pid}.tmp`
      await writeFile(staged, text, { mode: 0o600 })
      await rename(staged, target)
    }
  }
}

function newest<V>(record: Record<string, V>, key: string, value: V | null): Record<string, V> {
  const entries = Object.entries(record).filter(([existing]) => existing !== key)
  if (value !== null) {
    entries.push([key, value])
  }
  return Object.fromEntries(entries.slice(-MARKS_MAX))
}

function parseMarks(text: string | null): Marks {
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  const read = MarksSchema.safeParse(parsed)
  return read.success ? read.data : { kept: {}, closed: {} }
}

export class BotChatAutoCloseMarks {
  private marks: Marks = { kept: {}, closed: {} }
  private loading: Promise<void> | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly io: BotChatAutoCloseMarksIo) {}

  /** Reads the file once; every change waits for it, so none is written over the saved marks. */
  ready(): Promise<void> {
    this.loading ??= this.io
      .read()
      .then((text) => {
        this.marks = parseMarks(text)
      })
      .catch((error: unknown) => console.warn('[bots] could not read chat close marks', error))
    return this.loading
  }

  /** Writes land in order; the last one holds every change. */
  private save(next: Marks): void {
    this.marks = next
    const text = JSON.stringify(next)
    this.writing = this.writing
      .then(() => this.io.write(text))
      .catch((error: unknown) => console.warn('[bots] could not save chat close marks', error))
  }

  /** The item stamp Keep open was pressed against, if any. */
  keptStamp(key: string): string | null {
    return this.marks.kept[key] ?? null
  }

  setKept(key: string, stamp: string | null): void {
    if ((this.marks.kept[key] ?? null) !== stamp) {
      this.save({ ...this.marks, kept: newest(this.marks.kept, key, stamp) })
    }
  }

  /** When Orca closed the chat, while it stays closed; none before the file is read. */
  closedAt(key: string): number | null {
    return this.marks.closed[key] ?? null
  }

  setClosed(key: string, at: number | null): void {
    if ((this.marks.closed[key] ?? null) !== at) {
      this.save({ ...this.marks, closed: newest(this.marks.closed, key, at) })
    }
  }

  /** Reopening writes Keep open in the same save, so nothing re-arms the chat before the item set changes. */
  reopened(key: string, stamp: string): void {
    this.save({
      kept: newest(this.marks.kept, key, stamp),
      closed: newest(this.marks.closed, key, null)
    })
  }

  /** Every queued write has landed. */
  flushed(): Promise<void> {
    return this.writing
  }
}
