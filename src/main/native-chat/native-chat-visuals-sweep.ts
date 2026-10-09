// How a chat's visuals folder dies. The host never deletes a chat record, so no deletion event
// exists to hang cleanup on; instead each folder's life is derived from the records every run:
//   1. a folder no chat record (readable or not) maps to is removed, so any future record
//      deletion cleans up for free;
//   2. a folder whose chat ran in a local workspace this host can prove was removed is removed.
// Anything unproven is kept. A failure is logged and never blocks anything else.

import type { Dirent } from 'node:fs'
import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { yieldToEventLoop } from '../../shared/event-loop-yield'
import type { StructuredAgentSessionLogger } from './agent-session-wire/structured-agent-session-logger'
import { nativeChatVisualsFolderName, nativeChatVisualsRootFor } from './native-chat-visuals-folder'

/** `removed` only on positive proof from the host that owns the workspace. */
export type NativeChatVisualsWorkspaceVerdict = 'present' | 'removed' | 'unverifiable'

export type NativeChatVisualsSweepDeps = {
  stateDirectory: string
  /** Every chat this host holds a row for, readable or not; null when that can't be trusted. */
  listHeldSessionIds: () => readonly string[] | null
  locationOf: (sessionId: string) => AgentSessionExecutionLocation | null
  /** Called at most once per run, so one run judges every chat against one catalog snapshot.
   *  Absent: only rule 1 runs. */
  workspaceVerdicts?: () => (
    location: AgentSessionExecutionLocation
  ) => Promise<NativeChatVisualsWorkspaceVerdict>
  logger: StructuredAgentSessionLogger
  remove?: (path: string) => Promise<void>
}

export type NativeChatVisualsSweepResult = { removed: number; failed: number }

// Only names this host minted: anything else in the folder is never touched.
const FOLDER_NAME = /^[0-9a-f]{32}$/
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
  const root = nativeChatVisualsRootFor(deps.stateDirectory)
  // Listed before the records are read: a folder is created only after its chat's record, so
  // every folder seen here already has its record in the snapshot below.
  const entries = await listFolders(root)
  const held = deps.listHeldSessionIds()
  if (!held || entries.length === 0) {
    return result
  }
  const sessionByFolder = new Map(
    held.map((sessionId) => [nativeChatVisualsFolderName(sessionId), sessionId])
  )
  const remove = deps.remove ?? ((path: string) => rm(path, { recursive: true, force: true }))
  let verdict: ReturnType<NonNullable<NativeChatVisualsSweepDeps['workspaceVerdicts']>> | undefined
  const verdictFor = (location: AgentSessionExecutionLocation) =>
    (verdict ??= deps.workspaceVerdicts?.())?.(location)
  let visited = 0
  for (const entry of entries) {
    if (isStopped() || result.removed + result.failed >= MAX_REMOVALS_PER_RUN) {
      break
    }
    if (++visited % YIELD_EVERY === 0) {
      await yieldToEventLoop()
    }
    // A Dirent describes the entry itself, so a symlink is never followed or removed here.
    if (!entry.isDirectory() || !FOLDER_NAME.test(entry.name)) {
      continue
    }
    const sessionId = sessionByFolder.get(entry.name)
    const reason =
      sessionId === undefined ? 'no-record' : await removedWorkspace(deps, sessionId, verdictFor)
    if (!reason) {
      continue
    }
    try {
      await remove(join(root, entry.name))
      result.removed += 1
    } catch (error) {
      result.failed += 1
      deps.logger.warn('native-chat visuals folder could not be removed', {
        scope: 'nativeChatVisuals.sweep',
        reason,
        ...(sessionId ? { sessionId } : {}),
        error
      })
    }
  }
  return result
}

async function removedWorkspace(
  deps: Pick<NativeChatVisualsSweepDeps, 'locationOf'>,
  sessionId: string,
  verdictFor: (
    location: AgentSessionExecutionLocation
  ) => Promise<NativeChatVisualsWorkspaceVerdict> | undefined
): Promise<'workspace-removed' | null> {
  const location = deps.locationOf(sessionId)
  if (!location) {
    return null
  }
  try {
    return (await verdictFor(location)) === 'removed' ? 'workspace-removed' : null
  } catch {
    return null
  }
}

// Why minutes, not at boot: the first sweep must not compete with session restore and the
// workspace catalog loading; after that, a few runs a day is enough for files nothing reads.
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
