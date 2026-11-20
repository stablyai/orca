// Hermes's ACP server takes no system prompt, `_meta` or per-session environment: it builds the prompt
// from the folder's context files at a session's first turn, stores it with the session, and
// rebuilds it from them at each compaction. `.hermes.md` outranks AGENTS.md there and no other agent
// reads it (checked live on 0.23.3).

import { randomUUID } from 'node:crypto'
import { readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const HERMES_CONTEXT_FILE = '.hermes.md'

const HEADER = '<!-- Orca writes this file for Hermes chats in this folder; edits are replaced. -->'

const BLOCK_START = '<!-- orca:begin -->'
const BLOCK_END = '<!-- orca:end -->'

/** Orca's own file is replaced whole; a file the user wrote keeps their text and gets Orca's block. */
function withOrcaText(existing: string | null, text: string): string {
  if (existing === null || existing.startsWith(HEADER)) {
    return `${HEADER}\n\n${text}\n`
  }
  const block = `${BLOCK_START}\n${text}\n${BLOCK_END}`
  // The last pair wins, so marker text the user quotes earlier in their file is left alone.
  const end = existing.lastIndexOf(BLOCK_END)
  const start = end === -1 ? -1 : existing.lastIndexOf(BLOCK_START, end)
  if (start !== -1) {
    return existing.slice(0, start) + block + existing.slice(end + BLOCK_END.length)
  }
  return `${existing.trimEnd()}\n\n${block}\n`
}

/** Writes Orca's text into `cwd`'s `.hermes.md` whole, so a Hermes build never reads a half-written file.
 *  A file that cannot be read stays untouched, and a symlink keeps pointing at its target. */
export async function writeHermesContextFile(cwd: string, text: string): Promise<string> {
  const link = join(cwd, HERMES_CONTEXT_FILE)
  let path = link
  let existing: string | null = null
  let mode = 0o600
  try {
    path = await realpath(link)
    existing = await readFile(path, 'utf8')
    mode = (await stat(path)).mode & 0o777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path !== link) {
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
