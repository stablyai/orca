// `send --on <server>` carries words, not this computer's disk: a body naming a file here (a
// scratchpad, a report under the home folder) reaches an agent that can't open it. Warn, never refuse.
import { stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { isPathInsideOrEqual } from '../../../../../../shared/file-access/cross-platform-path'
import type { SendRecipientWarning } from './recipient-routing'

// A long body is checked for its first few paths only: the warning names a handful at most, and a
// pasted diff or page holds thousands of slashes ("a / b", "</div>"), each counted toward the cap.
const STARTS_MAX = 10
const MATCHES_MAX = 200
// A folder name can hold spaces ("Application Support"): each path is also tried this many words on.
const EXTRA_WORDS_MAX = 4
const NAMED_MAX = 3
/** How far past a path's start its line is read. */
export const LOCAL_PATH_LINE_MAX = 1024
/** Only this much of a body is searched for paths: the scan is advice, and a long body (a pasted log)
 *  must cost the send no more than a short one. The body itself is sent whole. */
export const LOCAL_PATH_SCAN_MAX = 64 * 1024
// The warning is advice: a stalled disk (a network home folder) never holds the send past this.
const LOOKUP_MAX_MS = 2000
const PATH_START = /(?:^|[\s"'`(<[=])((?:~|[A-Za-z]:)?[\\/])/g
const QUOTES = ['"', "'", '`']
const TRAILING = /[.,;:!?"'`)>\]]+$/
// "file.ts:42:7" names file.ts.
const LINE_NUMBER = /(?::\d+){1,2}$/

/** Folders that are this computer's own: another computer's paths there are some other user's or
 *  temporary. Paths elsewhere (/usr, /etc, a checkout both share) may well exist there too. */
function localRoots(): string[] {
  return [homedir(), tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders']
}

/** Each path start's readings, shortest first: through the first space, then each word after it. */
function candidates(body: string): string[][] {
  // Paths start only in the scanned region, but each one's line is read on past it, so a path the
  // region's end cuts still ends where the body ends it.
  const region = body.slice(0, LOCAL_PATH_SCAN_MAX)
  const home = homedir()
  const roots = localRoots()
  const starts: string[][] = []
  let matches = 0
  // A complete quoted path owns its text: no other path starts inside it.
  let quotedUntil = 0
  for (const match of region.matchAll(PATH_START)) {
    if (++matches > MATCHES_MAX) {
      break
    }
    const from = match.index + match[0].length - match[1].length
    if (from < quotedUntil) {
      continue
    }
    // The rest of this line, read one past LOCAL_PATH_LINE_MAX: that one tells a line ending there
    // from one running on.
    const rest = body.slice(from, from + LOCAL_PATH_LINE_MAX + 1)
    const newline = rest.indexOf('\n')
    const lookahead = rest.charAt(LOCAL_PATH_LINE_MAX)
    // The body ends within the read: right at the cap, or one space, tab or CR past it.
    const atEnd =
      from + rest.length === body.length &&
      (rest.length <= LOCAL_PATH_LINE_MAX || /[ \t\r]/.test(lookahead))
    // The line itself ends here (a newline or the body's end), or only its last word does (a space,
    // tab or CR just past the cap): a quote still open at the cap may close later on the line.
    const lineEnded = newline !== -1 || atEnd
    const wordEnded = lineEnded || /[ \t\r]/.test(lookahead)
    // A CRLF body's line ends in "\r", which no file name does.
    const line = (
      newline !== -1 ? rest.slice(0, newline) : rest.slice(0, LOCAL_PATH_LINE_MAX)
    ).replace(/\r$/, '')
    const { readings: raws, quoteClose } = lineReadings(
      line,
      { lineEnded, wordEnded },
      match[0].charAt(0)
    )
    if (quoteClose !== null) {
      quotedUntil = from + quoteClose
    }
    const readings = raws
      .map((raw) => raw.replace(TRAILING, '').replace(LINE_NUMBER, ''))
      .filter((raw) => raw.length > 1)
      .map((raw) => resolve(raw.startsWith('~') ? `${home}${raw.slice(1)}` : raw))
      // Inside one of them, never one of them (or above it): "~/" or the temp folder names no file.
      .filter(
        (path) =>
          roots.some((root) => isPathInsideOrEqual(root, path)) &&
          !roots.some((root) => isPathInsideOrEqual(path, root))
      )
    if (readings.length > 0) {
      starts.push(readings)
    }
    if (starts.length >= STARTS_MAX) {
      break
    }
  }
  return starts
}

/** What the path starting `line` may be, shortest first, each cut from the line's own text (so a
 *  folder name keeps its spaces, "My  Project"): through its first word, then each word after it.
 *  A quoted path is only its whole quoted text, and `quoteClose` is where its quote closes.
 *  `lineEnded`: the line truly ends where `line` does; `wordEnded`: at least its last word does. */
function lineReadings(
  line: string,
  { lineEnded, wordEnded }: { lineEnded: boolean; wordEnded: boolean },
  opener: string
): { readings: string[]; quoteClose: number | null } {
  if (QUOTES.includes(opener)) {
    const close = line.indexOf(opener)
    if (close !== -1) {
      return { readings: [line.slice(0, close)], quoteClose: close }
    }
    // The quote may close past the cap, so where the path ends is unknown. A quote never closed on
    // its line is no quoting: read the path as if unquoted.
    if (!lineEnded) {
      return { readings: [], quoteClose: null }
    }
  }
  const ends: number[] = []
  for (const word of line.matchAll(/[^ \t]+/g)) {
    const end = word.index + word[0].length
    // A line the cap cut may have cut its last word, so no reading ends on that word: it could name a
    // shorter file than the body does ("/tmp/report" of "/tmp/report-archive").
    if (end === line.length && !wordEnded) {
      break
    }
    ends.push(end)
    if (ends.length > EXTRA_WORDS_MAX) {
      break
    }
  }
  return { readings: ends.map((end) => line.slice(0, end)), quoteClose: null }
}

type PathStat = (path: string) => Promise<unknown>

/** The warning for paths in `body` that exist on this computer, or none. */
export async function localPathWarning(
  body: string | undefined,
  recipient: string,
  serverName: string,
  /** How a path is looked up; tests hold it to stand in for a stalled disk. */
  statPath: PathStat = stat
): Promise<SendRecipientWarning | null> {
  const starts = body ? candidates(body) : []
  if (starts.length === 0) {
    return null
  }
  const lookup = Promise.all(
    starts.map(async (readings) => {
      const real = await Promise.all(
        readings.map((path) =>
          statPath(path).then(
            () => true,
            () => false
          )
        )
      )
      // The longest reading that exists is the path the body names.
      return readings.findLast((_, index) => real[index]) ?? null
    })
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  const found = await Promise.race([
    lookup,
    new Promise<null>((done) => {
      timer = setTimeout(() => done(null), LOOKUP_MAX_MS)
    })
  ]).finally(() => clearTimeout(timer))
  // Too slow to wait on: the send goes without the warning, and the stat calls finish on their own.
  const local = [...new Set((found ?? []).filter((path) => path !== null))]
  if (local.length === 0) {
    return null
  }
  const shown = local.slice(0, NAMED_MAX)
  const items = local.length > NAMED_MAX ? [...shown, `${local.length - NAMED_MAX} more`] : shown
  // "a", "a and b", "a, b, and c".
  const named =
    items.length <= 2
      ? items.join(' and ')
      : `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`
  return {
    code: 'local_paths_unreadable',
    recipient,
    message: `The body names ${named} on this computer, which ${serverName} can't open. The message went as written; to share the contents, put the text in the body (--body-file reads a file into it), or attach it to a bot item with --file.`
  }
}
