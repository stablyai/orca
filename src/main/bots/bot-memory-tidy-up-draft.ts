// A tidy-up's draft: the new MEMORY.md, lines to file into memory/<topic>.md, and the lines a newer
// one replaced. Orca checks it against the file the run read, then writes it onto the files as they
// are now, so a chat's newer change wins.
import {
  applyBotMemoryChange,
  BOT_MEMORY_INDEX_LINE_CAP,
  type BotMemoryChange,
  botMemoryChange,
  botMemoryFactKeys,
  botMemoryLineKey,
  countBotMemoryLines,
  mergeBotMemoryChanges,
  parseBotMemoryFacts
} from '../../shared/bot-memory-lines'
import { dirname, join } from 'node:path'
import type { BotTidyUpSummary } from '../../shared/bots/bot-tidy-up'
import { redactSecretLike } from '../../shared/crash-reporting/crash-report-redaction'
import type { BotHomeFilesystem } from './bot-home'
import { liveGroupsMatch } from './bot-memory-tidy-up-groups'
import {
  TIDY_UP_ARCHIVE,
  TIDY_UP_FAILURES,
  TIDY_UP_INDEX_BLOCK,
  TIDY_UP_MAX_FILED,
  TIDY_UP_MAX_NEW_FACTS,
  TIDY_UP_REPLACED_BLOCK,
  TIDY_UP_TARGET_FACTS
} from './bot-memory-tidy-up'
export const TIDY_UP_TOPIC_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/

/** A draft that no longer fits the file: nothing is written. */
export class TidyUpRefused extends Error {}

export type TidyUpDraft = {
  index: string
  /** Lines to add to memory/<topic>.md, by topic. */
  topics: Map<string, string[]>
  /** Old MEMORY.md lines a newer line replaced. */
  replaced: string[]
}

/** What a checked draft does: its change to MEMORY.md as the run read it, and where the lines it
 *  takes out go. */
export type TidyUpPlan = {
  change: BotMemoryChange
  /** The draft's line for each fact it keeps, by key, which a repeated fact is merged into. */
  kept: Map<string, string>
  topics: Map<string, string[]>
  /** Keys of the lines filed into a topic, which the archive doesn't take. */
  filed: Set<string>
  /** Keys of the lines a newer one replaced. */
  replaced: Set<string>
  /** Ops only: keys of lines merged into one, of retired lines with why, and of lines it learned. */
  merged?: Set<string>
  retired?: Map<string, string>
  learned?: Set<string>
  merges?: number
  /** Ops and the status move: the lines of each fact they take out, as written, which the live
   *  file must still have exactly, so a copy written or changed since is never taken with them. */
  groups?: Map<string, string[]>
}

/** The blocks the run replied with; null without a MEMORY.md block. A later block of a name wins. */
export function tidyUpDraft(reply: string): TidyUpDraft | null {
  const blocks = new Map<string, string[]>()
  let open: { name: string; lines: string[] } | null = null
  for (const line of reply.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (open && trimmed === `END ${open.name}`) {
      blocks.set(open.name, open.lines)
      open = null
    } else if (open) {
      open.lines.push(line)
    } else if (trimmed.startsWith('BEGIN ')) {
      open = { name: trimmed.slice('BEGIN '.length).trim(), lines: [] }
    }
  }
  const index = blocks.get(TIDY_UP_INDEX_BLOCK)
  if (!index) {
    return null
  }
  const nonBlank = (lines: readonly string[]): string[] =>
    lines.map((line) => line.trimEnd()).filter((line) => line.trim() !== '')
  const topics = new Map<string, string[]>()
  for (const [name, lines] of blocks) {
    const topic = /^memory\/(.+)\.md$/.exec(name)?.[1]
    if (topic !== undefined) {
      topics.set(topic, nonBlank(lines))
    }
  }
  return {
    index: `${index.join('\n').trimEnd()}\n`,
    topics,
    replaced: nonBlank(blocks.get(TIDY_UP_REPLACED_BLOCK) ?? [])
  }
}

const looksSecret = (line: string): boolean => redactSecretLike(line) !== line
const keyOf = (line: string): string | null => botMemoryLineKey({ line, after: null })
const keysOf = (lines: readonly string[]): Set<string> =>
  new Set(lines.flatMap((line) => keyOf(line) ?? []))

/**
 * Orca's checks on a draft against the MEMORY.md the run read: what it will do, or why nothing
 * will. Secret-looking new lines are dropped, and lines without a date are never taken out.
 */
export function checkTidyUpDraft(
  before: string,
  draft: TidyUpDraft
): { plan: TidyUpPlan } | { refused: string } {
  if (countBotMemoryLines(draft.index) > BOT_MEMORY_INDEX_LINE_CAP) {
    return { refused: TIDY_UP_FAILURES.tooLong }
  }
  if (
    [...draft.topics.keys()].some(
      (name) => name === TIDY_UP_ARCHIVE || !TIDY_UP_TOPIC_NAME.test(name)
    )
  ) {
    return { refused: TIDY_UP_FAILURES.badTopic }
  }
  // Dropped before the diff, so no other line is placed after one.
  const secret = new Set(
    botMemoryChange(before, draft.index)
      .added.map(({ line }) => line)
      .filter(looksSecret)
  )
  const index = draft.index
    .split('\n')
    .filter((line) => !secret.has(line))
    .join('\n')
  // Filing only copies lines out of MEMORY.md, word for word as it has them: anything new goes
  // through the index's own change, the one History records and Undo reverts.
  const lineOf = new Map(
    before.split(/\r?\n/).flatMap((line) => {
      const key = keyOf(line)
      return key === null ? [] : [[key, line.trimEnd()] as const]
    })
  )
  const topics = new Map<string, string[]>()
  for (const [name, lines] of draft.topics) {
    const copied = lines.map((line, at) =>
      at === 0 && line.startsWith('# ') ? line : lineOf.get(keyOf(line) ?? '')
    )
    if (copied.some((line) => line === undefined)) {
      return { refused: TIDY_UP_FAILURES.notCopied }
    }
    topics.set(
      name,
      copied.filter((line) => line !== undefined)
    )
  }
  const filedLines = [...topics.values()].flat()
  if (filedLines.length > TIDY_UP_MAX_FILED) {
    return { refused: TIDY_UP_FAILURES.tooManyFiled }
  }
  const diff = botMemoryChange(before, index)
  const undated = keysOf(
    parseBotMemoryFacts(before)
      .filter((fact) => fact.date === null)
      .map((fact) => `- ${fact.text}`)
  )
  const change = {
    added: diff.added,
    removed: diff.removed.filter(({ line }) => !undated.has(keyOf(line) ?? ''))
  }
  const filed = keysOf(filedLines)
  const archived = change.removed.filter(({ line }) => !filed.has(keyOf(line) ?? ''))
  const facts = parseBotMemoryFacts(before).length
  if (archived.length > Math.max(Math.ceil(facts / 5), facts - TIDY_UP_TARGET_FACTS)) {
    return { refused: TIDY_UP_FAILURES.tooManyRemoved }
  }
  if (change.added.length > change.removed.length + TIDY_UP_MAX_NEW_FACTS) {
    return { refused: TIDY_UP_FAILURES.tooManyAdded }
  }
  const kept = new Map(
    index.split('\n').flatMap((line) => {
      const key = keyOf(line)
      return key === null ? [] : [[key, line] as const]
    })
  )
  return { plan: { change, kept, topics, filed, replaced: keysOf(draft.replaced) } }
}

/**
 * The plan's change for MEMORY.md as it is now, inside the memory writer: refused when a line it
 * takes out has changed or gone since the run read it (a chat's newer correction wins), or when
 * the result is over the cap. A fact the file states more than once is merged into the draft's line.
 */
export function tidyUpChangeFor(plan: TidyUpPlan, file: string): BotMemoryChange {
  const live = botMemoryFactKeys(file)
  if (plan.change.removed.some(({ line }) => !live.has(keyOf(line) ?? ''))) {
    throw new TidyUpRefused(TIDY_UP_FAILURES.changed)
  }
  if (plan.groups && !liveGroupsMatch(plan.groups, file)) {
    throw new TidyUpRefused(TIDY_UP_FAILURES.changed)
  }
  const removing = keysOf(plan.change.removed.map(({ line }) => line))
  const seen = new Map<string, number>()
  const anchors = new Map<string, string | null>()
  let previous: string | null = null
  for (const line of file.split(/\r?\n/)) {
    const key = keyOf(line)
    if (key !== null) {
      seen.set(key, (seen.get(key) ?? 0) + 1)
      if (!anchors.has(key)) {
        anchors.set(key, previous)
      }
    }
    previous = line.trim() === '' ? previous : line
  }
  // Taken out and put back once: the writer's change works by fact, so it can't drop one copy.
  const repeated = [...seen].flatMap(([key, count]) => {
    const line = plan.kept.get(key)
    return count > 1 && line !== undefined && !removing.has(key)
      ? [{ line, after: anchors.get(key) ?? null }]
      : []
  })
  const change = mergeBotMemoryChanges(plan.change, { added: repeated, removed: repeated })
  const lines = countBotMemoryLines(applyBotMemoryChange(file, change))
  // A change that shortens a file already past the cap still helps.
  if (lines > BOT_MEMORY_INDEX_LINE_CAP && lines > countBotMemoryLines(file)) {
    throw new TidyUpRefused(TIDY_UP_FAILURES.tooLong)
  }
  return change
}

/** Each memory/ file the change writes, by name, with the lines it gets: a line MEMORY.md loses
 *  goes to its topic or, marked moved or replaced, to the archive. */
export function tidyUpFileLines(
  plan: TidyUpPlan,
  removed: BotMemoryChange['removed'],
  today: string
): Map<string, string[]> {
  const files = new Map(plan.topics)
  // A filed line's other copies (another date, another mark) aren't in its topic: archive them.
  const inTopics = new Set([...plan.topics.values()].flat().map((line) => line.trimEnd()))
  const archived = removed.flatMap(({ line }) => {
    const key = keyOf(line)
    if (key === null || (plan.filed.has(key) && inTopics.has(line.trimEnd()))) {
      return []
    }
    if (plan.merged?.has(key)) {
      return [`${line.trimEnd()} \u00b7 merged ${today}`]
    }
    const retired = plan.retired?.get(key)
    if (retired) {
      return [`${line.trimEnd()} \u00b7 retired (${retired}) ${today}`]
    }
    if (!plan.replaced.has(key)) {
      return [`${line.trimEnd()} · moved ${today}`]
    }
    const [fact] = parseBotMemoryFacts(line)
    return [`- ${fact?.date ? `${fact.date} ` : ''}~~${fact?.text ?? line}~~ · replaced ${today}`]
  })
  if (archived.length > 0) {
    files.set(TIDY_UP_ARCHIVE, archived)
  }
  return files
}

/** A memory/ file with `lines` added, each once; null when it has them all already. */
export function tidyUpFileText(name: string, text: string | null, lines: string[]): string | null {
  const have = new Set((text ?? '').split(/\r?\n/).map((line) => line.trim()))
  const adding = lines.filter(
    (line, at) => !have.has(line.trim()) && !(at === 0 && text !== null && line.startsWith('# '))
  )
  if (adding.length === 0) {
    return null
  }
  const heading = adding[0].startsWith('# ')
    ? ''
    : `# ${name === TIDY_UP_ARCHIVE ? 'Archive' : name}\n`
  const start = text === null ? heading : `${text.trimEnd()}\n`
  return `${start}${adding.join('\n')}\n`
}

/** Each memory/ file with its new lines, guarded like MEMORY.md's own writes: an unreadable or
 *  changing file is never written over, and a retry adds nothing twice. Adds to `written` each
 *  file's lines it really added, headings aside. */
export async function writeTidyUpFiles(
  fs: Pick<BotHomeFilesystem, 'readText' | 'writeText' | 'replaceText' | 'makeDirectory'>,
  folder: string,
  plan: TidyUpPlan,
  made: BotMemoryChange,
  today: string,
  written: Map<string, number>
): Promise<void> {
  const files = tidyUpFileLines(plan, made.removed, today)
  for (const [name, lines] of files) {
    const path = join(folder, 'memory', `${name}.md`)
    await fs.makeDirectory(dirname(path))
    const before = await fs.readText(path)
    const next = tidyUpFileText(name, before, lines)
    if (next === null) {
      continue
    }
    const had = new Set((before ?? '').split(/\r?\n/).map((line) => line.trim()))
    const adding = lines.filter((line) => !line.startsWith('# ') && !had.has(line.trim()))
    const wrote =
      before === null
        ? await fs.writeText(path, next, { exclusive: true })
        : await fs.replaceText(path, before, next)
    if (!wrote) {
      throw new Error(`memory/${name}.md changed or could not be read`)
    }
    written.set(name, (written.get(name) ?? 0) + adding.length)
  }
}

const POINTER = /memory\/[a-z0-9-]+\.md/
const factText = (line: string): string => parseBotMemoryFacts(line)[0]?.text ?? line.trim()

/** What a tidy-up changed, for its summary: `asked` is what it asked the writer for, `made` what
 *  MEMORY.md took, `written` the lines each memory/ file took. */
export function tidyUpSummaryOf(
  plan: TidyUpPlan,
  asked: BotMemoryChange,
  made: BotMemoryChange,
  written: ReadonlyMap<string, number>
): Pick<BotTidyUpSummary, 'learned' | 'replaced' | 'filed' | 'moved' | 'merged'> {
  const removed = made.removed.flatMap(({ line }) => {
    const key = keyOf(line)
    return key === null ? [] : [{ key, line }]
  })
  const askedRemoved = keysOf(asked.removed.map(({ line }) => line))
  return {
    learned: made.added.flatMap(({ line }) => {
      const learned = plan.learned ? plan.learned.has(keyOf(line) ?? '') : !POINTER.test(line)
      return learned ? [factText(line)] : []
    }),
    replaced: removed.flatMap(({ key, line }) => (plan.replaced.has(key) ? [factText(line)] : [])),
    filed: [...plan.topics.keys()].flatMap((topic) => {
      const count = written.get(topic) ?? 0
      return count > 0 ? [{ topic, count }] : []
    }),
    moved: removed.filter(
      ({ key }) => !plan.filed.has(key) && !plan.replaced.has(key) && !plan.merged?.has(key)
    ).length,
    merged:
      plan.merges ?? asked.added.filter(({ line }) => askedRemoved.has(keyOf(line) ?? '')).length
  }
}
