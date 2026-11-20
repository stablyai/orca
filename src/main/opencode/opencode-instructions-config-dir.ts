// OpenCode 2.x reads no `instructions` from inline or file config; over ACP its only instruction
// sources are AGENTS.md files: the global one in its config folder and the project's. So a chat gets
// a config folder of its own that links every entry of the user's and adds the instructions to the
// global AGENTS.md (checked live on 2.0.16, a fresh-process reopen included).

import { cp, link, lstat, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hasReachedAppVersion } from '../../shared/app-lifecycle/identity/app-version'
import { resolveOpenCodeConfigDirectory } from '../../shared/agent-launch/plugins/opencode/opencode-config-directory'

const GLOBAL_INSTRUCTIONS_FILE = 'AGENTS.md'

/** The first release line that drops config `instructions` and reads its config folder's AGENTS.md. */
export const OPENCODE_CONFIG_DIR_INSTRUCTIONS_FIRST_VERSION = '2.0.0'

export function openCodeTakesConfigDirInstructions(version: string | null): boolean {
  return (
    version !== null &&
    hasReachedAppVersion(version, OPENCODE_CONFIG_DIR_INSTRUCTIONS_FIRST_VERSION)
  )
}

/** The config folder the child would read without Orca: its own OPENCODE_CONFIG_DIR, else the XDG one. */
export function openCodeSourceConfigDirectory(env: Readonly<Record<string, string>>): string {
  return env.OPENCODE_CONFIG_DIR?.trim() || resolveOpenCodeConfigDirectory(env)
}

/** Links a user's entry, never copying through a link of theirs: as `mirrorEntry`, without blocking. */
async function linkEntry(source: string, target: string): Promise<void> {
  const stats = await lstat(source)
  const directory = !stats.isSymbolicLink() && stats.isDirectory()
  if (process.platform !== 'win32') {
    await symlink(source, target, directory ? 'dir' : 'file')
    return
  }
  if (directory) {
    await symlink(source, target, 'junction')
    return
  }
  await link(source, target).catch(() => cp(source, target))
}

// Followed: a dotfiles setup often links the whole config folder.
async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (stats) => stats.isDirectory(),
    () => false
  )
}

/** Fills the empty `folder` with links to `source`'s entries and an AGENTS.md holding the user's
 *  own global instructions, then `text`. Links keep the user's edits live and send OpenCode's own
 *  writes to their files. */
export async function writeOpenCodeInstructionsConfigDir(
  folder: string,
  source: string,
  text: string
): Promise<void> {
  let own: string | null = null
  if (await isDirectory(source)) {
    for (const name of await readdir(source)) {
      if (name === GLOBAL_INSTRUCTIONS_FILE) {
        own = await readFile(join(source, name), 'utf8').catch(() => null)
        continue
      }
      await linkEntry(join(source, name), join(folder, name))
    }
  }
  const combined = [own?.trim(), text].filter((part) => part).join('\n\n')
  await writeFile(join(folder, GLOBAL_INSTRUCTIONS_FILE), `${combined}\n`, { mode: 0o600 })
}
