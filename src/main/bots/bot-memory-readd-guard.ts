// A chat that rewrites MEMORY.md from what it read at its start can put back lines a tidy-up moved out
// since. At its turn end such a line is kept out of MEMORY.md and filed in memory/archive.md instead,
// unless its owner's own words in that turn ask for it.
import { join } from 'node:path'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { botMemoryDate, parseBotMemoryFacts } from '../../shared/bot-memory-lines'
import type { BotMemoryHistoryRow } from '../../shared/bots/bot-memory-history'
import type { BotHomeFilesystem } from './bot-home'
import type { BotMemoryRecord } from './bot-memory-record'
import { keyWords, lineCoverage, lineWords, wordSimilarity } from './bot-memory-line-words'
import { ownerTypedWords, TIDY_UP_OPS_PILOT_FILE } from './bot-memory-ops-pilot'
import { ownerChatLines, TIDY_UP_ARCHIVE } from './bot-memory-tidy-up'
import { tidyUpFileText } from './bot-memory-tidy-up-draft'

export const READD_GUARD_MS = 14 * 24 * 60 * 60 * 1000
const SAME_LINE = 0.8
/** Share of the line's key words the owner's own words must hold for the owner to have asked. */
const OWNER_ASKED = 0.5

const plain = (line: string): string =>
  lineWords(parseBotMemoryFacts(line)[0]?.text ?? line).join(' ')

/** The lines of `added` a tidy-up moved out of MEMORY.md in the last two weeks, by their words or
 *  near enough, that `ownerWords` doesn't ask for. */
export function linesToKeepOut(
  added: readonly string[],
  history: readonly BotMemoryHistoryRow[],
  ownerWords: string,
  now: number
): string[] {
  const moved = history
    .filter((row) => row.by.kind === 'tidy-up' && row.at >= now - READD_GUARD_MS)
    .flatMap((row) => row.change.removed.map(({ line }) => line))
  if (moved.length === 0) {
    return []
  }
  const words = new Set(moved.map(plain))
  const movedWords = moved.map(keyWords)
  return added.filter((line) => {
    const mine = keyWords(line)
    return (
      (words.has(plain(line)) ||
        movedWords.some((old) => wordSimilarity(old, mine) >= SAME_LINE)) &&
      lineCoverage(line, ownerWords) < OWNER_ASKED
    )
  })
}

type GuardFilesystem = Pick<BotHomeFilesystem, 'readText' | 'replaceText' | 'writeText'> &
  Partial<Pick<BotHomeFilesystem, 'makeDirectory'>>

/** What a pilot bot's turn end keeps out of what it added, filed in the archive first so a line
 *  is never lost; undefined off the pilot. */
export async function readdGuard(
  fs: GuardFilesystem,
  { botId, folder }: { botId: string; folder: string },
  record: Pick<BotMemoryRecord, 'history'>,
  turn: readonly AgentJournalRenderItem[],
  now = Date.now()
): Promise<((added: string[]) => Promise<string[]>) | undefined> {
  if ((await fs.readText(join(folder, TIDY_UP_OPS_PILOT_FILE))) === null) {
    return undefined
  }
  return async (added) => {
    const owner = ownerTypedWords([{ title: null, lines: ownerChatLines(turn, 0) }])
    const rows = await record.history(botId).catch(() => [])
    const out = linesToKeepOut(added, rows, owner.flat().join('\n'), now)
    const today = botMemoryDate(new Date(now))
    return out.length > 0 && (await fileKeptOutLines(fs, folder, out, today)) ? out : []
  }
}

/** Files lines a turn end kept out into memory/archive.md, so none is lost; false when it can't. */
export async function fileKeptOutLines(
  fs: GuardFilesystem,
  folder: string,
  lines: readonly string[],
  today: string
): Promise<boolean> {
  const path = join(folder, 'memory', `${TIDY_UP_ARCHIVE}.md`)
  const marked = lines.map((line) => `${line.trimEnd()} · kept out ${today}`)
  await fs.makeDirectory?.(join(folder, 'memory'))
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await fs.readText(path)
    const next = tidyUpFileText(TIDY_UP_ARCHIVE, before, marked)
    if (next === null) {
      return true
    }
    const wrote =
      before === null
        ? await fs.writeText(path, next, { exclusive: true })
        : await fs.replaceText(path, before, next)
    if (wrote) {
      return true
    }
  }
  return false
}
