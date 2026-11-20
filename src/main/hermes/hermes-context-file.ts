// Hermes's ACP server takes no system prompt, `_meta` or per-session environment: it builds the prompt
// from the folder's context files at a session's first turn, stores it with the session, and
// rebuilds it from them at each compaction. `.hermes.md` outranks AGENTS.md there and no other agent
// reads it (checked live on 0.23.3).

import { randomUUID } from 'node:crypto'
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const HERMES_CONTEXT_FILE = '.hermes.md'

const HEADER = '<!-- Orca writes this file for Hermes chats in this folder; edits are replaced. -->'

const BLOCK_START = '<!-- orca:begin -->'
const BLOCK_END = '<!-- orca:end -->'

/** Orca's own file is replaced whole; a file the user wrote keeps their text and gets Orca's block. */
function withOrcaText(existing: string | null, rawText: string): string {
  const text = rawText.replace(/<!--\s*orca:(begin|end)\s*-->/g, '')
  if (existing === null || existing.startsWith(HEADER)) {
    return `${HEADER}\n\n${text}\n`
  }
  const block = `${BLOCK_START}\n${text}\n${BLOCK_END}`
  // Only markers alone on their lines count, so text that quotes them is left alone; the last
  // pair wins, so a stray one the user wrote earlier cannot swallow their text.
  const marks = [...existing.matchAll(/^<!-- orca:(begin|end) -->\r?$/gm)]
  const end = marks.findLast((mark) => mark[1] === 'end')
  const start = end && marks.findLast((mark) => mark[1] === 'begin' && mark.index < end.index)
  if (start && end) {
    const endAt = end.index + end[0].length
    return existing.slice(0, start.index) + block + existing.slice(endAt)
  }
  return `${existing.trimEnd()}\n\n${block}\n`
}

/** Writes Orca's text into `cwd`'s `.hermes.md` whole, so a Hermes build never reads a half-written file.
 *  A symlink or a file that cannot be read stays untouched. */
export async function writeHermesContextFile(cwd: string, text: string): Promise<string> {
  const link = join(cwd, HERMES_CONTEXT_FILE)
  const path = link
  let existing: string | null = null
  let mode = 0o600
  const info = await lstat(link).catch(() => null)
  if (info) {
    // A link may point outside the folder or into a tracked file, so it is left as the user's.
    if (info.isSymbolicLink()) {
      return link
    }
    try {
      existing = await readFile(link, 'utf8')
      mode = info.mode & 0o777
    } catch {
      return link
    }
  }
  const staged = `${path}.${randomUUID()}`
  try {
    await writeFile(staged, withOrcaText(existing, text), { mode })
    await rename(staged, path)
  } catch (error) {
    await rm(staged, { force: true }).catch(() => undefined)
    throw error
  }
  return link
}
