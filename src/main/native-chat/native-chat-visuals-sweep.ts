// Keep scratch folders for every retained chat, regardless of age; remove only folders without records.
// Restore legacy .expired folders still belonging to chats; cleanup failures never block startup.

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
  /** Include unreadable chats; null means the roster cannot be trusted. */
  listHeldSessionIds: () => readonly string[] | null
  logger: StructuredAgentSessionLogger
  remove?: (path: string) => Promise<void>
}

export type NativeChatVisualsSweepResult = { removed: number; failed: number }

// Legacy cleanup renamed folders before removal; interrupted removals leave these behind.
const EXPIRED_SUFFIX = '.expired'
const MAX_REMOVALS_PER_RUN = 200
const YIELD_EVERY = 32

async function listFolders(root: string): Promise<Dirent[]> {
  try {
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
  // List folders first: each was created after its chat record, so the later roster must include it.
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
    // Dirents inspect the entry itself; never follow or remove symlinks.
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

// Delay the first sweep to avoid competing with session restore.
const FIRST_SWEEP_DELAY_MS = 2 * 60_000
const SWEEP_INTERVAL_MS = 6 * 60 * 60_000

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
