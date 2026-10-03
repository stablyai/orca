import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import {
  isAutomaticTabActivation,
  type TabActivationIntent
} from '../../shared/tab-activation-intent'
import {
  runtimeWorktreeIdentityKey,
  runtimeWorktreeIdsEqual
} from './runtime-worktree-path-identity'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { indexPersistedPtyPaneBindings } from './runtime-worktree-binding-index'
import { WORKTREE_TERMINAL_SLEEP_BLOCKED_ERROR } from './worktree-terminal-mutation-lock'

export type WorktreeTerminalSleepState = {
  worktreeId: string
  generation: number
  phase: 'stopping' | 'partial' | 'sleeping'
  ptyIds: string[]
  terminalHandles: string[]
  terminalHandlesByPtyId: Record<string, string[]>
  paneKeysByPtyId: Record<string, string>
}

export type WorktreeTerminalSpawnSurface = { ptyId?: string; paneKey?: string }

export function captureTerminalSleepPanes(
  ptyIds: Iterable<string>,
  records: ReadonlyMap<string, { paneKey?: string | null }>,
  session: WorkspaceSessionState | null | undefined,
  worktreeId: string
): Record<string, string> {
  const paneKeys: Record<string, string> = {}
  const persisted = indexPersistedPtyPaneBindings(session)
  for (const ptyId of ptyIds) {
    const saved = persisted.get(ptyId)
    const paneKey =
      records.get(ptyId)?.paneKey ??
      (saved && runtimeWorktreeIdsEqual(saved.worktreeId, worktreeId) ? saved.paneKey : undefined)
    if (paneKey) {
      paneKeys[ptyId] = paneKey
    }
  }
  return paneKeys
}

export function blocksAutomaticTerminalSpawnForSleep(
  state: WorktreeTerminalSleepState | undefined,
  surface: WorktreeTerminalSpawnSurface
): boolean {
  if (!state) {
    return false
  }
  if (state.phase !== 'partial') {
    return true
  }
  const matches = (ptyId: string): boolean =>
    ptyId === surface.ptyId ||
    (surface.paneKey !== undefined && state.paneKeysByPtyId[ptyId] === surface.paneKey)
  if (state.ptyIds.some(matches)) {
    return true
  }
  if (state.ptyIds.every((ptyId) => Boolean(state.paneKeysByPtyId[ptyId]))) {
    return false
  }
  // Unknown committed identities cannot license a fresh automatic replacement.
  return !Object.keys(state.terminalHandlesByPtyId).some(
    (ptyId) => !state.ptyIds.includes(ptyId) && matches(ptyId)
  )
}

export async function acquireWorktreeTerminalSpawnLease(args: {
  worktreeId?: string
  activationIntent?: TabActivationIntent
  surface: WorktreeTerminalSpawnSurface
  sleepStates: Map<string, WorktreeTerminalSleepState>
  acquire: (worktreeId: string) => Promise<() => void>
  emit: (event: RuntimeClientEvent) => void
}): Promise<() => void> {
  if (!args.worktreeId) {
    return () => {}
  }
  const release = await args.acquire(args.worktreeId)
  const key = runtimeWorktreeIdentityKey(args.worktreeId)
  const sleepState = args.sleepStates.get(key)
  // Recovery queued during teardown must judge its pane after Sleep settles.
  if (isAutomaticTabActivation(args.activationIntent)) {
    if (blocksAutomaticTerminalSpawnForSleep(sleepState, args.surface)) {
      release()
      throw new Error(WORKTREE_TERMINAL_SLEEP_BLOCKED_ERROR)
    }
    return release
  }
  if (sleepState?.phase === 'sleeping' || sleepState?.phase === 'partial') {
    args.sleepStates.delete(key)
    args.emit({
      type: 'worktreeTerminalSleepState',
      worktreeId: sleepState.worktreeId,
      generation: sleepState.generation,
      phase: 'woken',
      ptyIds: sleepState.ptyIds,
      terminalHandles: sleepState.terminalHandles
    })
  }
  return release
}
