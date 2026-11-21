// The journal Orca keeps for a bot: one line in memory/journal/YYYY-MM.md each time one of its items
// closes, with its PRs' states, taken from Items and the desktop's PR cache. No model writes it and
// no bot needs to, so finished work stays findable after status leaves MEMORY.md.
import { join } from 'node:path'
import { botMemoryDate } from '../../shared/bot-memory-lines'
import type { BotItem } from '../../shared/bots/bot-items'
import type { BotHomeFilesystem } from './bot-home'
import { cleanBotWorkText } from './bot-work-turn-note'

/** PRs read per item; the rest are named without a state. */
export const JOURNAL_PRS_PER_ITEM = 5

export type JournalItem = Pick<BotItem, 'number' | 'title' | 'status' | 'links'> & {
  closedAt: number
}

/** The item's lines, each starting `- YYYY-MM-DD |` so a sort over all journal files is by date. */
export function journalLines(item: JournalItem): string[] {
  const date = botMemoryDate(new Date(item.closedAt))
  const title = cleanBotWorkText(item.title)
  // Each PR once by its full ref ("o/r#7"), so two repos' #7 stay two PRs.
  const prs = [
    ...new Map(
      item.links.flatMap((link) => {
        if (link.kind !== 'pr' && !(link.kind === 'dispatch' && link.pr)) {
          return []
        }
        const ref = (link.pr?.shown ? link.pr.ref : link.ref).replace(/^pr:/, '')
        return [[ref, link.pr] as const]
      })
    )
  ]
  const head = `- ${date} | item #${item.number}`
  if (prs.length === 0) {
    return [`${head} | ${item.status} | ${title}`]
  }
  const numberOf = (ref: string): string | undefined => /#(\d+)$/.exec(ref)?.[1]
  const shared = (ref: string): boolean =>
    prs.filter(([other]) => numberOf(other) === numberOf(ref)).length > 1
  return prs.map(([ref, pr], index) => {
    // Named by number (an unread one too, so it reads the same once the cache learns it), with
    // its repo when another linked PR has the same number.
    const number = numberOf(ref)
    const name = number === undefined || shared(ref) ? `PR ${ref}` : `PR #${number}`
    const state =
      index >= JOURNAL_PRS_PER_ITEM
        ? 'state not read'
        : pr?.shown
          ? pr.state === 'open' || pr.state === 'draft'
            ? 'open at close'
            : pr.state
          : 'state unknown'
    return `${head} | ${name} ${state} | ${title}`
  })
}

/** The close a line belongs to: its date and item. A close is journaled once, all its lines in
 *  one append, so a pass that sees it again (a PR's state or links changed since) adds nothing. */
function closeKey(line: string): string {
  const [date = '', item = ''] = line.split(' | ')
  return `${date} | ${item}`
}

/** Adds `lines` to their months' journal files, each close once; throws when a file kept changing
 *  under it, so the caller tries those lines again later. */
export async function appendJournalLines(
  fs: Pick<BotHomeFilesystem, 'readText' | 'writeText' | 'replaceText' | 'makeDirectory'>,
  folder: string,
  lines: readonly string[]
): Promise<number> {
  const months = new Map<string, string[]>()
  for (const line of lines) {
    const month = /^- (\d{4}-\d{2})-/.exec(line)?.[1]
    if (month) {
      months.set(month, [...(months.get(month) ?? []), line])
    }
  }
  let added = 0
  for (const [month, adding] of months) {
    const path = join(folder, 'memory', 'journal', `${month}.md`)
    await fs.makeDirectory(join(folder, 'memory', 'journal'))
    let done = false
    for (let attempt = 0; attempt < 3 && !done; attempt += 1) {
      const before = await fs.readText(path)
      const have = new Set((before ?? '').split(/\r?\n/).map(closeKey))
      const fresh = [...new Set(adding)].filter((line) => !have.has(closeKey(line)))
      if (fresh.length === 0) {
        done = true
        break
      }
      const start = before === null ? `# Journal ${month}\n` : `${before.trimEnd()}\n`
      const next = `${start}${fresh.join('\n')}\n`
      done =
        before === null
          ? await fs.writeText(path, next, { exclusive: true })
          : await fs.replaceText(path, before, next)
      added += done ? fresh.length : 0
    }
    if (!done) {
      throw new Error(`memory/journal/${month}.md kept changing`)
    }
  }
  return added
}
