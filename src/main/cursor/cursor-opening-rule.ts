// Cursor's ACP server takes no system prompt, `_meta` or plugin rules; it reads the folder's
// `.cursor/rules` once per process, at its first `session/new` or `session/load`, and keeps them
// for that process only (read from the 2026.09.28 bundle). So the rule exists only while a session
// opens, and every open places it.

import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  rmdir,
  stat,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'

/** Older launches wrote this fixed name; it is never written or removed now, since its author is unknowable. */
export const CURSOR_OPENING_RULE_FILE = 'orca-standing-instructions.mdc'

// Each launch writes its own file named after a hash of its bytes, so a crashed launch's rule is
// provably Orca's only while its bytes are untouched; an edited one is the user's.
const OWN_RULE_NAME = /^orca-standing-instructions-([0-9a-f]{32})-[0-9a-f-]{36}\.mdc$/
// Another Orca process may be mid-open in this folder; only a rule older than any open is a leftover.
const LEFTOVER_AGE_MS = 10 * 60_000

/** Opens in one folder wait for each other, so a session never reads another's rule. */
const opening = new Map<string, Promise<void>>()

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

function bytesHash(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32)
}

/** Removes `file` only while it is a plain file holding exactly the bytes Orca wrote. */
async function removeIfUnchanged(file: string, isUnchanged: (bytes: Buffer) => boolean) {
  const info = await lstat(file).catch(() => undefined)
  if (!info?.isFile()) {
    return
  }
  const bytes = await readFile(file).catch(() => undefined)
  if (bytes && isUnchanged(bytes)) {
    await rm(file, { force: true })
  }
}

/** Rules a crashed open left behind; every open of the folder in this process holds the lock. */
async function sweepLeftoverRules(rulesDir: string): Promise<void> {
  for (const name of await readdir(rulesDir).catch(() => [])) {
    const hash = OWN_RULE_NAME.exec(name)?.[1]
    const file = join(rulesDir, name)
    const info = hash ? await lstat(file).catch(() => undefined) : undefined
    if (!hash || !info || Date.now() - info.mtimeMs < LEFTOVER_AGE_MS) {
      continue
    }
    await removeIfUnchanged(file, (bytes) => bytesHash(bytes) === hash).catch(() => undefined)
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
  const bytes = `---\ndescription: Orca's standing instructions for this chat\nalwaysApply: true\n---\n${text}\n`
  const path = join(rulesDir, `orca-standing-instructions-${bytesHash(bytes)}-${randomUUID()}.mdc`)
  try {
    const made = [
      ...((await exists(cursorDir)) ? [] : [cursorDir]),
      ...((await exists(rulesDir)) ? [] : [rulesDir])
    ]
    await mkdir(rulesDir, { recursive: true })
    await sweepLeftoverRules(rulesDir)
    // Exclusive: never replaces a file, so nothing the user has is overwritten.
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
    return async () => {
      try {
        // A user who edited the rule while the session opened keeps their edit.
        await removeIfUnchanged(path, (current) => current.toString('utf8') === bytes)
        // Innermost first; a folder that gained the user's own files stays.
        for (const dir of made.toReversed()) {
          await rmdir(dir).catch(() => undefined)
        }
      } finally {
        releaseFolder()
      }
    }
  } catch (error) {
    // Unless the exclusive create found a file there, the name is this launch's alone.
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      await rm(path, { force: true }).catch(() => undefined)
    }
    releaseFolder()
    throw error
  }
}
