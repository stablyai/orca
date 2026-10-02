// The old per-chat files on disk, for the background copy: where they are, what is left once they
// are copied, and whether the volume has room to copy one.

import { existsSync } from 'node:fs'
import { readdir, rmdir, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import {
  legacyJournalDatabaseFile,
  perChatJournalRoot
} from '../agent-session-journal/journal-paths'
import type { PerChatFileState } from '../agent-session-journal/journal-per-session-source'

const MIN_FREE_BYTES = 512 * 1024 * 1024
/** Free space a chat needs before its copy starts, as a multiple of its file and WAL. */
const FREE_SPACE_FACTOR = 4

/** Each `<workspace>/<session>` directory that still holds a `journal.db`, one at a time. A
 *  directory without one is counted and kept: a pre-SQLite transcript, or an older build's. */
export async function* walkPerChatFiles(
  stateDirectory: string,
  onLeftover: () => void
): AsyncGenerator<string> {
  const root = perChatJournalRoot(stateDirectory)
  for (const workspace of await readdirOrEmpty(root)) {
    for (const session of await readdirOrEmpty(join(root, workspace))) {
      const directory = join(root, workspace, session)
      if (existsSync(legacyJournalDatabaseFile(directory))) {
        yield directory
      } else {
        onLeftover()
      }
    }
  }
}

/** Best effort, and only what is empty: anything left in a directory is the user's. */
export async function removeEmptyPerChatDirectories(stateDirectory: string): Promise<void> {
  const root = perChatJournalRoot(stateDirectory)
  for (const workspace of await readdirOrEmpty(root)) {
    await rmdir(join(root, workspace)).catch(() => undefined)
  }
  await rmdir(root).catch(() => undefined)
}

/** Room on the state volume to copy this chat: `copy` with max(512 MiB, 4 x its file and WAL) free
 *  (or unknown), `skip` when only this chat is too big for what is free, and `wait` below 512 MiB,
 *  where no chat copies. */
export async function roomToCopy(
  stateDirectory: string,
  file: PerChatFileState,
  freeBytes: (directory: string) => Promise<number | null> = freeBytesOnVolume
): Promise<'copy' | 'skip' | 'wait'> {
  const free = await freeBytes(stateDirectory)
  if (free === null) {
    return 'copy'
  }
  if (free < MIN_FREE_BYTES) {
    return 'wait'
  }
  return free >= FREE_SPACE_FACTOR * (file.dbSize + (file.walSize ?? 0)) ? 'copy' : 'skip'
}

async function readdirOrEmpty(directory: string): Promise<string[]> {
  try {
    return await readdir(directory)
  } catch {
    return []
  }
}

async function freeBytesOnVolume(directory: string): Promise<number | null> {
  try {
    const stats = await statfs(directory)
    const bytes = Number(stats.bsize) * Number(stats.bavail)
    return Number.isFinite(bytes) ? bytes : null
  } catch {
    return null
  }
}
