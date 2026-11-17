import { lstat, mkdir, realpath, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { removeDirectoryLink } from '../../../filesystem/merged-directory-link'
import { CLAUDE_PROFILE_HISTORY_DIRS } from './claude-profile-history'

export const CLAUDE_PRIVATE_HISTORY_MARKER = '.orca-private-history'

export async function isolateClaudeProfileHistory(
  home: string,
  defaultHome: string
): Promise<void> {
  if ((await realpath(home)) === (await realpath(defaultHome).catch(() => null))) {
    throw new Error('The system Claude home cannot be isolated as an account profile.')
  }
  for (const name of [...CLAUDE_PROFILE_HISTORY_DIRS, 'sessions', 'history.jsonl']) {
    const target = join(home, name)
    const shared = join(defaultHome, name)
    const entry = await lstat(target).catch((error) => {
      if (error.code === 'ENOENT') {
        return null
      }
      throw error
    })
    if (!entry) {
      continue
    }
    const sharedEntry = await lstat(shared).catch(() => null)
    const hardLinked =
      entry.isFile() &&
      entry.nlink > 1 &&
      sharedEntry?.isFile() &&
      entry.ino === sharedEntry.ino &&
      entry.dev === sharedEntry.dev
    if (!entry.isSymbolicLink() && !hardLinked) {
      continue
    }
    if (
      entry.isSymbolicLink() &&
      (await realpath(target)) !== (await realpath(shared).catch(() => null))
    ) {
      throw new Error(
        'Claude history points outside its shared store. Remove that link before isolating this account.'
      )
    }
    if (name === 'history.jsonl') {
      await unlink(target)
      await writeFile(target, '', { mode: 0o600 })
    } else {
      await removeDirectoryLink(target)
      await mkdir(target, { mode: 0o700 })
    }
  }
  await writeFile(join(home, CLAUDE_PRIVATE_HISTORY_MARKER), '', { mode: 0o600 })
}
