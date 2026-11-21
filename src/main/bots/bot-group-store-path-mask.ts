import { AGENT_SESSION_ATTACHMENTS_DIR_NAME } from '../../shared/agent-session/agent-session-attachments'

// Masks this computer's attachment-store paths in words sent to another computer, in one pass: the
// store's folder and upload id are found first, then each path is widened to its root and its end,
// so a long run of text is never rescanned.

const STORE_ENTRY = new RegExp(`${AGENT_SESSION_ATTACHMENTS_DIR_NAME}[\\\\/]+[0-9a-f-]{36}`, 'gi')
const PATH_END = /[\s"]/
const ROOT_BOUNDARY = /[\s"'([]/
const SLASH = /[\\/]/

/** Each attachment-store path in `words` replaced by `mask`: the whole path from its root, even
 *  when a folder name has spaces ("/Users/Alice Smith/…"), or, written without a root, from its
 *  first character. */
export function maskStorePaths(words: string, mask: string): string {
  let masked = ''
  let last = 0
  for (const entry of words.matchAll(STORE_ENTRY)) {
    if (entry.index < last) {
      continue
    }
    const start = pathStart(words, entry.index, last)
    let end = entry.index + entry[0].length
    while (end < words.length && !PATH_END.test(words[end])) {
      end++
    }
    masked += words.slice(last, start) + mask
    last = end
  }
  return masked + words.slice(last)
}

/** Where the path holding the store folder at `at` begins, no earlier than `floor`: its leftmost
 *  root on the same line and outside quotes when the folder follows a slash, else its word. */
function pathStart(words: string, at: number, floor: number): number {
  let word = at
  while (word > floor && !PATH_END.test(words[word - 1])) {
    word--
  }
  if (at === 0 || !SLASH.test(words[at - 1])) {
    return word
  }
  let root = -1
  for (
    let index = at - 1;
    index >= floor && words[index] !== '\n' && words[index] !== '"';
    index--
  ) {
    if (isRoot(words, index)) {
      root = index
    }
  }
  return root === -1 ? word : Math.min(root, word)
}

/** A path root at `index`: `/`, `\`, `~/` or a drive (`C:\`), at the start or after a space,
 *  quote or bracket. */
function isRoot(words: string, index: number): boolean {
  if (index > 0 && !ROOT_BOUNDARY.test(words[index - 1])) {
    return false
  }
  const char = words[index]
  return (
    SLASH.test(char) ||
    (char === '~' && SLASH.test(words[index + 1] ?? '')) ||
    (/[A-Za-z]/.test(char) && words[index + 1] === ':' && SLASH.test(words[index + 2] ?? ''))
  )
}
