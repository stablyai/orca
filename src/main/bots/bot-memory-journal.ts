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
  const prs = [
    ...new Map(
      item.links.flatMap((link) =>
        link.kind === 'pr' || (link.kind === 'dispatch' && link.pr)
          ? [[link.pr?.shown ? link.pr.number : link.ref, link.pr] as const]
          : []
      )
    )
  ]
  const head = `- ${date} | item #${item.number}`
  if (prs.length === 0) {
    return [`${head} | ${item.status} | ${title}`]
  }
  return prs.map(([number, pr], index) => {
    const name = typeof number === 'number' ? `PR #${number}` : number
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

/** A line's identity: its date, item and PR (or close status), not the PR's state, so a state the
 *  cache learned later never writes the same close twice. */
function journalKey(line: string): string {
  const [date = '', item = '', what = ''] = line.split(' | ')
  return [date, item, /^(PR #\d+|\S+)/.exec(what)?.[1] ?? what].join(' | ')
}

/** Adds `lines` to their months' journal files, each once by its identity; throws when a file kept
 *  changing under it, so the caller tries those lines again later. */
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
      const have = new Set((before ?? '').split(/\r?\n/).map(journalKey))
      const fresh = [...new Map(adding.map((line) => [journalKey(line), line])).entries()]
        .filter(([key]) => !have.has(key))
        .map(([, line]) => line)
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
