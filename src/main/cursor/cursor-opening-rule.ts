// Cursor's ACP server takes no system prompt, `_meta` or plugin rules; it reads the folder's
// `.cursor/rules` when `session/new` runs and keeps them with the session, reopens included
// (checked live on 2026.06.02 and 2026.11.19). So the rule exists only while a session opens.

import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const CURSOR_OPENING_RULE_FILE = 'orca-standing-instructions.mdc'

/** Opens in one folder wait for each other, so a session never reads another's rule. */
const opening = new Map<string, Promise<void>>()

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

/** Writes `text` as an always-applied rule in `cwd` and returns what removes it, along with any
 *  folder it made. */
export async function placeCursorOpeningRule(
  cwd: string,
  text: string
): Promise<() => Promise<void>> {
  const previous = opening.get(cwd) ?? Promise.resolve()
  let release!: () => void
  const held = previous.then(() => new Promise<void>((resolve) => (release = resolve)))
  opening.set(cwd, held)
  await previous
  const releaseFolder = (): void => {
    release()
    if (opening.get(cwd) === held) {
      opening.delete(cwd)
    }
  }
  const cursorDir = join(cwd, '.cursor')
  const rulesDir = join(cursorDir, 'rules')
  const path = join(rulesDir, CURSOR_OPENING_RULE_FILE)
  try {
    const made = [
      ...((await exists(cursorDir)) ? [] : [cursorDir]),
      ...((await exists(rulesDir)) ? [] : [rulesDir])
    ]
    await mkdir(rulesDir, { recursive: true })
    const staged = `${path}.${randomUUID()}`
    await writeFile(
      staged,
      `---\ndescription: Orca's standing instructions for this chat\nalwaysApply: true\n---\n${text}\n`,
      { mode: 0o600 }
    )
    await rename(staged, path)
    return async () => {
      try {
        await rm(path, { force: true })
        // Innermost first; a folder that gained the user's own files stays.
        for (const dir of made.toReversed()) {
          await rmdir(dir).catch(() => undefined)
        }
      } finally {
        releaseFolder()
      }
    }
  } catch (error) {
    await rm(path, { force: true }).catch(() => undefined)
    releaseFolder()
    throw error
  }
}
