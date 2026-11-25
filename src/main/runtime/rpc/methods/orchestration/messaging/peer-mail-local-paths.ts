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
const LINE_MAX = 1024
/** Only this much of a body is searched for paths: the scan is advice, and a long body (a pasted log)
 *  must cost the send no more than a short one. The body itself is sent whole. */
export const LOCAL_PATH_SCAN_MAX = 64 * 1024
// The warning is advice: a stalled disk (a network home folder) never holds the send past this.
const LOOKUP_MAX_MS = 2000
const PATH_START = /(?:^|[\s"'`(<[=])((?:~|[A-Za-z]:)?[\\/])/g
const TRAILING = /[.,;:!?"'`)>\]]+$/
// "file.ts:42:7" names file.ts.
const LINE_NUMBER = /(?::\d+){1,2}$/

/** Folders that are this computer's own: another computer's paths there are some other user's or
 *  temporary. Paths elsewhere (/usr, /etc, a checkout both share) may well exist there too. */
function localRoots(): string[] {
  return [homedir(), tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders']
}

/** Each path start's readings, shortest first: through the first space, then each word after it. */
function candidates(whole: string): string[][] {
  const body = whole.slice(0, LOCAL_PATH_SCAN_MAX)
  const home = homedir()
  const roots = localRoots()
  const starts: string[][] = []
  let matches = 0
  for (const match of body.matchAll(PATH_START)) {
    if (++matches > MATCHES_MAX) {
      break
    }
    const from = match.index + match[0].length - match[1].length
    // Only the rest of this line, read at most LINE_MAX on: a body has many path-like starts.
    const rest = body.slice(from, from + LINE_MAX)
    const end = rest.indexOf('\n')
    // A CRLF body's line ends in "\r", which no file name does.
    const line = (end === -1 ? rest : rest.slice(0, end)).replace(/\r$/, '')
    const words = line.split(/[ \t]+/).slice(0, EXTRA_WORDS_MAX + 1)
    const readings = words
      .map((_, count) =>
        words
          .slice(0, count + 1)
          .join(' ')
          .replace(TRAILING, '')
          .replace(LINE_NUMBER, '')
      )
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
  const named = local.slice(0, NAMED_MAX).join(', ')
  const more = local.length > NAMED_MAX ? ` and ${local.length - NAMED_MAX} more` : ''
  return {
    code: 'local_paths_unreadable',
    recipient,
    message: `The body names ${named}${more} on this computer, which ${serverName} can't open. The message went as written; to share the contents, put the text in the body (--body-file reads a file into it), or attach the file with --file on a bot's item.`
  }
}
