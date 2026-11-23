// Hermes's ACP server takes no system prompt, `_meta` or per-session environment: it builds the prompt
// from the folder's context files at a session's first turn, stores it with the session, and
// rebuilds it from them at each compaction. `.hermes.md` outranks AGENTS.md there and no other agent
// reads it (checked live on 0.23.3).

import { randomUUID } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const HERMES_CONTEXT_FILE = '.hermes.md'

const HEADER = '<!-- Orca writes this file for Hermes chats in this folder; edits are replaced. -->'

/** Replaces `cwd`'s `.hermes.md` whole, so a Hermes build never reads a half-written file. */
export async function writeHermesContextFile(cwd: string, text: string): Promise<string> {
  const path = join(cwd, HERMES_CONTEXT_FILE)
  const staged = `${path}.${randomUUID()}`
  try {
    await writeFile(staged, `${HEADER}\n\n${text}\n`, { mode: 0o600 })
    await rename(staged, path)
  } catch (error) {
    await rm(staged, { force: true }).catch(() => undefined)
    throw error
  }
  return path
}
