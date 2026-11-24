// The finished run chat list's lines: a chat's countdown, or a later line taking it off the list.
import { z } from 'zod'

const EntrySchema = z.object({
  sessionId: z.string().min(1),
  botId: z.string().min(1),
  /** When its countdown last started: the run's end, or the last time it was busy or active. */
  since: z.number(),
  /** Held open by something that ends on its own (a tab, an item, an answer): it sets no timer and is
   *  checked again in the next sweep another chat starts, or once after a restart. */
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
