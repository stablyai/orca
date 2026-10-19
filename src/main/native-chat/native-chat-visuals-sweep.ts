// How a chat's scratch folder dies. The host never deletes a chat record, so no deletion event
// exists to hang cleanup on; instead each folder's life is re-derived every run:
//   1. a folder no chat record (readable or not) maps to is removed, so any future record
//      deletion cleans up for free;
//   2. a folder whose chat went unused for the retention window is removed: its newest journal row
//      and everything in the folder are older than that, and the host holds no execution for it.
// Rule 2 decides again under the chat's lane and then its folder lock, so a start or a save that
// lands after the first look keeps the folder. A failure is logged and never blocks anything else.

import type { Dirent } from 'node:fs'
import { lstat, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { yieldToEventLoop } from '../../shared/event-loop-yield'
import type { StructuredAgentSessionLogger } from './agent-session-wire/structured-agent-session-logger'
import {
  isNativeChatScratchFolderName,
  nativeChatScratchFolderName,
  nativeChatScratchRootFor
} from './native-chat-scratch-folder'
import {
  runUnderNativeChatScratchFolderLock,
  trackNativeChatScratchExpiryCandidate
} from './native-chat-scratch-folder-lock'

/** How long a chat's scratch files outlive its last use. */
export const NATIVE_CHAT_SCRATCH_RETENTION_MS = 30 * 24 * 60 * 60_000

export type NativeChatVisualsSweepDeps = {
  stateDirectory: string
  /** Every chat this host holds a row for, readable or not; null when that can't be trusted. */
  listHeldSessionIds: () => readonly string[] | null
  /** When the chat's newest journal row was saved; null when it has none. */
  lastJournalActivityAt: (sessionId: string) => number | null
  /** Runs `task` in the chat's lane unless the host holds execution for it; null when it does. */
  runWhileExecutionIdle: <T>(sessionId: string, task: () => Promise<T>) => Promise<T | null>
  logger: StructuredAgentSessionLogger
  remove?: (path: string) => Promise<void>
}

export type NativeChatVisualsSweepResult = { removed: number; failed: number }

// Renamed under the locks and deleted after them; a cut-short delete leaves it for a later run.
const EXPIRED_SUFFIX = '.expired'
// Bounds one run's disk work; whatever is left goes in a later run.
const MAX_REMOVALS_PER_RUN = 200
const YIELD_EVERY = 32

async function listFolders(root: string): Promise<Dirent[]> {
  try {
    // A root that is not a real directory is not one this host made; nothing under it is touched.
    if (!(await lstat(root)).isDirectory()) {
      return []
    }
    return await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return []
    }
    throw error
  }
}

export async function sweepNativeChatVisualsFolders(
  deps: NativeChatVisualsSweepDeps,
  isStopped: () => boolean = () => false
): Promise<NativeChatVisualsSweepResult> {
  const result = { removed: 0, failed: 0 }
  const root = nativeChatScratchRootFor(deps.stateDirectory)
  // Listed before the records are read: a folder is created only after its chat's record, so
  // every folder seen here already has its record in the snapshot below.
  const entries = await listFolders(root)
  const held = deps.listHeldSessionIds()
  if (!held || entries.length === 0) {
    return result
  }
  const sessionByFolder = new Map(
    held.map((sessionId) => [nativeChatScratchFolderName(sessionId), sessionId])
  )
  const remove = deps.remove ?? ((path: string) => rm(path, { recursive: true, force: true }))
  const cutoff = Date.now() - NATIVE_CHAT_SCRATCH_RETENTION_MS
  let visited = 0
  for (const entry of entries) {
    if (isStopped() || result.removed + result.failed >= MAX_REMOVALS_PER_RUN) {
      break
    }
    if (++visited % YIELD_EVERY === 0) {
      await yieldToEventLoop()
    }
    const expired = entry.name.endsWith(EXPIRED_SUFFIX)
    const folderName = expired ? entry.name.slice(0, -EXPIRED_SUFFIX.length) : entry.name
    // A Dirent describes the entry itself, so a symlink is never followed or removed here.
    if (!entry.isDirectory() || !isNativeChatScratchFolderName(folderName)) {
      continue
    }
    const sessionId = expired ? undefined : sessionByFolder.get(entry.name)
    const reason = expired ? 'expired' : sessionId === undefined ? 'no-record' : 'unused'
    try {
      if (
        sessionId !== undefined &&
        !(await parkUnusedFolder(deps, root, folderName, sessionId, cutoff))
      ) {
        continue
      }
      await remove(join(root, sessionId === undefined ? entry.name : folderName + EXPIRED_SUFFIX))
      result.removed += 1
    } catch (error) {
      result.failed += 1
      deps.logger.warn('native-chat scratch folder could not be removed', {
        scope: 'nativeChatVisuals.sweep',
        reason,
        ...(sessionId ? { sessionId } : {}),
        error
      })
    }
  }
  return result
}

/** Renames a chat's folder to `<name>.expired` under the chat's lane and then its folder lock;
 *  false when the chat was used since `cutoff`, holds live work, or a save landed after the scan. */
async function parkUnusedFolder(
  deps: NativeChatVisualsSweepDeps,
  root: string,
  name: string,
  sessionId: string,
  cutoff: number
): Promise<boolean> {
  const folder = join(root, name)
  const usedSince = (): boolean => (deps.lastJournalActivityAt(sessionId) ?? 0) >= cutoff
  // Before the scan, so a save already running when it starts still marks it stale.
  const candidate = trackNativeChatScratchExpiryCandidate(name)
  try {
    if (usedSince() || (await changedSince(folder, cutoff))) {
      return false
    }
    const parked = await deps.runWhileExecutionIdle(sessionId, () =>
      runUnderNativeChatScratchFolderLock(name, async () => {
        if (!candidate.isCurrent() || usedSince()) {
          return false
        }
        await rename(folder, folder + EXPIRED_SUFFIX)
        return true
      })
    )
    return parked === true
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return false
    }
    throw error
  } finally {
    candidate.dispose()
  }
}

/** Whether the folder or anything under it changed at or after `cutoff`. Every entry is read with
 *  lstat, so a link is judged as itself and never followed; the scan stops at the first change. */
async function changedSince(folder: string, cutoff: number): Promise<boolean> {
  const pending = [folder]
  let visited = 0
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    if ((await lstat(dir)).mtimeMs >= cutoff) {
      return true
    }
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++visited % YIELD_EVERY === 0) {
        await yieldToEventLoop()
      }
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        pending.push(path)
      } else if ((await lstat(path)).mtimeMs >= cutoff) {
        return true
      }
    }
  }
  return false
}

// Why minutes, not at boot: the first sweep must not compete with session restore; after that, a
// few runs a day is enough for files nothing reads.
const FIRST_SWEEP_DELAY_MS = 2 * 60_000
const SWEEP_INTERVAL_MS = 6 * 60 * 60_000

/** Runs the sweep after startup and then periodically; the returned stop ends both. */
export function scheduleNativeChatVisualsSweep(deps: NativeChatVisualsSweepDeps): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const run = async (): Promise<void> => {
    try {
      await sweepNativeChatVisualsFolders(deps, () => stopped)
    } catch (error) {
      deps.logger.warn('native-chat visuals sweep failed', {
        scope: 'nativeChatVisuals.sweep',
        error
      })
    }
    arm(SWEEP_INTERVAL_MS)
  }
  const arm = (delayMs: number): void => {
    if (stopped) {
      return
    }
    timer = setTimeout(() => void run(), delayMs)
    timer.unref?.()
  }
  arm(FIRST_SWEEP_DELAY_MS)
  return () => {
    stopped = true
    if (timer) {
      clearTimeout(timer)
    }
  }
}
