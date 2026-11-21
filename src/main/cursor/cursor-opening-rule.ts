// Cursor's ACP server takes no system prompt, `_meta` or plugin rules; it reads the folder's
// `.cursor/rules` when `session/new` runs and keeps them with the session, reopens included
// (checked live on 2026.06.02 and 2026.11.19). So the rule exists only while a session opens.

import { randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'

export const CURSOR_OPENING_RULE_FILE = 'orca-standing-instructions.mdc'

const RULE_MARKER = "description: Orca's standing instructions for this chat"

/** Opens in one folder wait for each other, so a session never reads another's rule. */
const opening = new Map<string, Promise<void>>()

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

/** Only a missing file is free; a link or a file that cannot be read is the user's. */
async function isUserFile(path: string): Promise<boolean> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      return true
    }
    return !(await readFile(path, 'utf8')).startsWith(RULE_HEAD)
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
  }
}

const RULE_HEAD = `---\n${RULE_MARKER}\n`
const LEFTOVER_NAME =
  /^orca-standing-instructions-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.mdc$/
const SIBLING_PREFIX = 'orca-standing-instructions-'

/** Rules a crashed open left beside a user's file; every open of the folder holds the lock. */
async function sweepLeftoverRules(rulesDir: string): Promise<void> {
  for (const name of await readdir(rulesDir).catch(() => [])) {
    if (!LEFTOVER_NAME.test(name)) {
      continue
    }
    const file = join(rulesDir, name)
    const isLink = await lstat(file).then(
      (info) => info.isSymbolicLink(),
      () => true
    )
    const text = isLink ? '' : await readFile(file, 'utf8').catch(() => '')
    if (text.startsWith(RULE_HEAD)) {
      await rm(file, { force: true }).catch(() => undefined)
    }
  }
}

/** Writes `text` as an always-applied rule in `cwd` and returns what removes it, along with any
 *  folder it made. */
export async function placeCursorOpeningRule(
  cwd: string,
  text: string
): Promise<() => Promise<void>> {
  const key = await realpath(cwd).catch(() => cwd)
  const previous = opening.get(key) ?? Promise.resolve()
  let release!: () => void
  const held = previous.then(() => new Promise<void>((resolve) => (release = resolve)))
  opening.set(key, held)
  await previous
  const releaseFolder = (): void => {
    release()
    if (opening.get(key) === held) {
      opening.delete(key)
    }
  }
  const cursorDir = join(cwd, '.cursor')
  const rulesDir = join(cursorDir, 'rules')
  let path = join(rulesDir, CURSOR_OPENING_RULE_FILE)
  try {
    const made = [
      ...((await exists(cursorDir)) ? [] : [cursorDir]),
      ...((await exists(rulesDir)) ? [] : [rulesDir])
    ]
    await mkdir(rulesDir, { recursive: true })
    await sweepLeftoverRules(rulesDir)
    // A file the user wrote under this name is theirs: this chat's rule goes beside it.
    if (await isUserFile(path)) {
      path = join(rulesDir, `${SIBLING_PREFIX}${randomUUID()}.mdc`)
    }
    const staged = `${path}.${randomUUID()}`
    await writeFile(staged, `---\n${RULE_MARKER}\nalwaysApply: true\n---\n${text}\n`, {
      mode: 0o600
    })
    await rename(staged, path)
    return async () => {
      try {
        if (!(await isUserFile(path))) {
          await rm(path, { force: true })
        }
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
