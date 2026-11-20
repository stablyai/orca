// Hermes's ACP server takes no system prompt, `_meta` or per-session environment: it builds the prompt
// from the folder's context files at a session's first turn, stores it with the session, and
// rebuilds it from them at each compaction. `.hermes.md` outranks AGENTS.md there and no other agent
// reads it (checked live on 0.23.3).

import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
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
  const start = existing.indexOf(BLOCK_START)
  const end = existing.indexOf(BLOCK_END, start)
  if (start !== -1 && end !== -1) {
    return existing.slice(0, start) + block + existing.slice(end + BLOCK_END.length)
  }
  return `${existing.trimEnd()}\n\n${block}\n`
}

/** Writes Orca's text into `cwd`'s `.hermes.md` whole, so a Hermes build never reads a half-written file. */
export async function writeHermesContextFile(cwd: string, text: string): Promise<string> {
  const path = join(cwd, HERMES_CONTEXT_FILE)
  const staged = `${path}.${randomUUID()}`
  try {
    const existing = await readFile(path, 'utf8').catch(() => null)
    await writeFile(staged, withOrcaText(existing, text), { mode: 0o600 })
    await rename(staged, path)
  } catch (error) {
    await rm(staged, { force: true }).catch(() => undefined)
    throw error
  }
  return path
}
