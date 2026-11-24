// The finished run chat list: a chat's countdown per line, or a later line taking it off the list.
import { z } from 'zod'

const EntrySchema = z.object({
  sessionId: z.string().min(1),
  botId: z.string().min(1),
  /** When its countdown last started: the run's end, or the last time it was busy or active. */
  since: z.number(),
  /** Held open by something that ends on its own (a viewer, an item, an answer): it sets no timer
   *  until what ends the hold wakes it, besides one check per launch. */
  parked: z.literal(true).optional()
})
export type Entry = z.infer<typeof EntrySchema>
// A later line that takes a chat off the list.
const RemovedSchema = z.object({ sessionId: z.string().min(1), removed: z.literal(true) })

export type Line = Entry | z.infer<typeof RemovedSchema>

// Leading newline: a line a crash cut short never swallows the next one.
export function lineText(line: Line): string {
  return `\n${JSON.stringify(line)}`
}

// An unreadable line leaves that chat as it was, so at worst it stays open.
export function parseLine(line: string): Line | null {
  if (!line.trim()) {
    return null
  }
  try {
    const json: unknown = JSON.parse(line)
    const removed = RemovedSchema.safeParse(json)
    if (removed.success) {
      return removed.data
    }
    const entry = EntrySchema.safeParse(json)
    return entry.success ? entry.data : null
  } catch {
    return null
  }
}

// The list is rewritten once its lines (changes appended since the last rewrite) pass this many per
// tracked chat, so writes stay proportional to changes.
const COMPACT_LINES_PER_CHAT = 2
const COMPACT_MIN_LINES = 1000

export type RunChatListFile = {
  path: () => string
  read: (path: string) => Promise<string | null>
  append: (path: string, text: string) => Promise<void>
  write: (path: string, text: string) => Promise<void>
}

/** The tracked chats in memory, with each bot's parked ones, read once per profile path. */
export class RunChatList {
  private path: string | null = null
  private readonly byChat = new Map<string, Entry>()
  private readonly parkedByBot = new Map<string, Set<string>>()
  private lines = 0

  constructor(private readonly file: RunChatListFile) {}

  async load(): Promise<ReadonlyMap<string, Entry>> {
    const path = this.file.path()
    if (this.path !== path) {
      this.byChat.clear()
      this.parkedByBot.clear()
      this.lines = 0
      const text = await this.file.read(path).catch(() => null)
      for (const line of text?.split('\n') ?? []) {
        const parsed = parseLine(line)
        if (parsed) {
          this.lines += 1
          this.apply(parsed)
        }
      }
      this.path = path
    }
    return this.byChat
  }

  /** The bot's chats waiting on something that ends on its own. */
  parkedOf(botId: string): readonly string[] {
    return [...(this.parkedByBot.get(botId) ?? [])]
  }

  /** Applies the changes in memory and on disk: appended, or rewritten once lines outgrow chats. */
  async save(changes: readonly Line[]): Promise<void> {
    if (changes.length === 0) {
      return
    }
    await this.load()
    changes.forEach((line) => this.apply(line))
    const path = this.file.path()
    try {
      const lines = this.lines + changes.length
      if (lines > Math.max(COMPACT_MIN_LINES, this.byChat.size * COMPACT_LINES_PER_CHAT)) {
        await this.file.write(path, [...this.byChat.values()].map(lineText).join(''))
        this.lines = this.byChat.size
      } else {
        await this.file.append(path, changes.map(lineText).join(''))
        this.lines = lines
      }
    } catch (error) {
      console.warn('[bots] could not save the finished run chat list', error)
    }
  }

  private apply(line: Line): void {
    const before = this.byChat.get(line.sessionId)
    const parked = before && this.parkedByBot.get(before.botId)
    if (parked) {
      parked.delete(line.sessionId)
      if (parked.size === 0) {
        this.parkedByBot.delete(before.botId)
      }
    }
    this.byChat.delete(line.sessionId)
    if ('removed' in line) {
      return
    }
    this.byChat.set(line.sessionId, line)
    if (line.parked) {
      const bot = this.parkedByBot.get(line.botId) ?? new Set<string>()
      bot.add(line.sessionId)
      this.parkedByBot.set(line.botId, bot)
    }
  }
}
