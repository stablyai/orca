// How a chat's scratch folder dies: with its chat. The host never deletes a chat record, so no
// deletion event exists to hang cleanup on; instead every run removes each folder no chat record
// (readable or not) maps to, so any future record deletion cleans up for free. A folder is never
// removed for its age: a chat's visuals live as long as the chat, and one an older build set aside
// as unused goes back to its chat. A failure is logged and never blocks anything else.

import type { Dirent } from 'node:fs'
import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { yieldToEventLoop } from '../../shared/event-loop-yield'
import type { StructuredAgentSessionLogger } from './agent-session-wire/structured-agent-session-logger'
import {
  isNativeChatScratchFolderName,
  nativeChatScratchFolderName,
  nativeChatScratchRootFor
} from './native-chat-scratch-folder'

export type NativeChatVisualsSweepDeps = {
  stateDirectory: string
  /** Every chat this host holds a row for, readable or not; null when that can't be trusted. */
  listHeldSessionIds: () => readonly string[] | null
  logger: StructuredAgentSessionLogger
  remove?: (path: string) => Promise<void>
}

export type NativeChatVisualsSweepResult = { removed: number; failed: number }

// What older builds renamed an unused chat's folder to before deleting it; a cut-short delete left it.
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
  const heldFolders = new Set(held.map(nativeChatScratchFolderName))
  const remove = deps.remove ?? ((path: string) => rm(path, { recursive: true, force: true }))
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
    try {
      if (heldFolders.has(folderName)) {
        continue
      }
      await remove(join(root, entry.name))
      result.removed += 1
    } catch (error) {
      result.failed += 1
      deps.logger.warn('native-chat scratch folder could not be removed', {
        scope: 'nativeChatVisuals.sweep',
        reason: expired ? 'set-aside' : 'no-record',
        error
      })
    }
  }
  return result
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
