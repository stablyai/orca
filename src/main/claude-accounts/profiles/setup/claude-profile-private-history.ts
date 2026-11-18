import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  unlink,
  writeFile
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { removeDirectoryLink } from '../../../filesystem/merged-directory-link'
import { CLAUDE_PROFILE_HISTORY_DIRS } from './claude-profile-history'
import {
  detachClaudeHistoryDirectory,
  restoreClaudeHistorySnapshot
} from './claude-profile-history-snapshot'

export const CLAUDE_PRIVATE_HISTORY_MARKER = '.orca-private-history'

export async function isolateClaudeProfileHistory(
  home: string,
  defaultHome: string
): Promise<void> {
  if ((await realpath(home)) === (await realpath(defaultHome).catch(() => null))) {
    throw new Error('The system Claude home cannot be isolated as an account profile.')
  }
  for (const name of [...CLAUDE_PROFILE_HISTORY_DIRS, 'sessions', 'history.jsonl']) {
    if (name !== 'sessions' && name !== 'history.jsonl') {
      await restoreClaudeHistorySnapshot(home, name)
    }
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
    const recorded =
      name === 'history.jsonl'
        ? await readFile(join(home, 'history.jsonl.orca-profile-link'), 'utf8').catch((error) => {
            if (error.code === 'ENOENT') {
              return null
            }
            throw error
          })
        : null
    const identity = await lstat(target, { bigint: true })
    const retiredLink = entry.isFile() && recorded?.trim() === `${identity.dev}:${identity.ino}`
    const hardLinked =
      entry.isFile() &&
      entry.nlink > 1 &&
      sharedEntry?.isFile() &&
      entry.ino === sharedEntry.ino &&
      entry.dev === sharedEntry.dev
    if (!entry.isSymbolicLink() && !hardLinked && !retiredLink) {
      continue
    }
    if (entry.isSymbolicLink()) {
      const physicalTarget = await realpath(target).catch(() => null)
      const physicalShared = await realpath(shared).catch(() => null)
      if (
        !(physicalTarget && physicalTarget === physicalShared) &&
        resolve(dirname(target), await readlink(target)) !== resolve(shared)
      ) {
        throw new Error(
          'Claude history points outside its shared store. Remove that link before isolating this account.'
        )
      }
    }
    if (name === 'history.jsonl') {
      await (retiredLink
        ? rename(target, `${target}.orca-profile-conflict-${randomUUID()}`)
        : unlink(target))
      await writeFile(target, '', { flag: 'wx', mode: 0o600 }).catch((error) => {
        if (error.code !== 'EEXIST') {
          throw error
        }
      })
    } else if (name === 'sessions') {
      await removeDirectoryLink(target)
      await mkdir(target, { mode: 0o700 })
    } else {
      await detachClaudeHistoryDirectory(home, shared, name)
    }
  }
  await writeFile(join(home, CLAUDE_PRIVATE_HISTORY_MARKER), '', { mode: 0o600 })
}
