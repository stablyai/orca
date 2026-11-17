// Deletes the per-chat journal.db files that predate the host's one database. Since #26038 nothing
// reads them, and a deleted chat's file was never removed. Chats that still have a record keep
// theirs; other files beside the journal (pre-SQLite transcripts) are the user's and stay.

import type { Dirent } from 'node:fs'
import { readdir, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { yieldToEventLoop } from '../../../shared/concurrency/event-loop-yield'
import { isDefinitiveAbsence } from '../../../shared/errors/definitive-filesystem-absence'
import type { StructuredAgentSessionLogger } from '../agent-session-wire/host/structured-agent-session-logger'
import {
  isNativeChatScratchFolderName,
  nativeChatScratchFolderName
} from '../conversation-files/native-chat-scratch-folder'

const PER_CHAT_ROOT_NAME = 'agent-session-journal'
const PER_CHAT_FILES = ['journal.db', 'journal.db-wal', 'journal.db-shm']
const YIELD_EVERY = 32
// After session restore, which reads the store this sweep consults.
const SWEEP_DELAY_MS = 3 * 60_000

export type PerChatJournalFileSweepDeps = {
  stateDirectory: string
  /** Include unreadable chats; null means the roster cannot be trusted. */
  listHeldSessionIds: () => readonly string[] | null
  logger: StructuredAgentSessionLogger
}

export type PerChatJournalFileSweepResult = { removed: number; failed: number }

async function listDirectories(path: string): Promise<Dirent[]> {
  try {
    // Dirents describe the entry itself, so symlinks are never followed.
    return (await readdir(path, { withFileTypes: true })).filter(
      (entry) => entry.isDirectory() && isNativeChatScratchFolderName(entry.name)
    )
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return []
    }
    throw error
  }
}

async function removeIfEmpty(path: string): Promise<void> {
  try {
    await rmdir(path)
  } catch {
    // Not empty: something beside the journal is kept.
  }
}

export async function sweepPerChatJournalFiles(
  deps: PerChatJournalFileSweepDeps,
  isStopped: () => boolean = () => false
): Promise<PerChatJournalFileSweepResult> {
  const result = { removed: 0, failed: 0 }
  const root = join(deps.stateDirectory, PER_CHAT_ROOT_NAME)
  const workspaces = await listDirectories(root)
  if (workspaces.length === 0) {
    return result
  }
  const held = deps.listHeldSessionIds()
  if (!held) {
    return result
  }
  // Same 32-hex sha256 segment the per-chat layout used for its session folder.
  const heldFolders = new Set(held.map(nativeChatScratchFolderName))
  let visited = 0
  for (const workspace of workspaces) {
    const workspaceDir = join(root, workspace.name)
    for (const chat of await listDirectories(workspaceDir)) {
      if (isStopped()) {
        return result
      }
      if (++visited % YIELD_EVERY === 0) {
        await yieldToEventLoop()
      }
      if (heldFolders.has(chat.name)) {
        continue
      }
      const chatDir = join(workspaceDir, chat.name)
      try {
        // The database before its WAL, as the importer retired them.
        for (const name of PER_CHAT_FILES) {
          await rm(join(chatDir, name), { force: true })
        }
        result.removed += 1
      } catch (error) {
        result.failed += 1
        deps.logger.warn('old per-chat journal file could not be removed', {
          scope: 'agentSessionJournal.perChatSweep',
          error
        })
        continue
      }
      await removeIfEmpty(chatDir)
    }
    await removeIfEmpty(workspaceDir)
  }
  await removeIfEmpty(root)
  return result
}

export function schedulePerChatJournalFileSweep(deps: PerChatJournalFileSweepDeps): () => void {
  let stopped = false
  const timer = setTimeout(() => {
    sweepPerChatJournalFiles(deps, () => stopped).catch((error: unknown) => {
      deps.logger.warn('old per-chat journal sweep failed', {
        scope: 'agentSessionJournal.perChatSweep',
        error
      })
    })
  }, SWEEP_DELAY_MS)
  timer.unref?.()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
