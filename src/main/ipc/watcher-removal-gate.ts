import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'
import {
  TERMINAL_REMOVAL_IN_PROGRESS_MESSAGE,
  WATCHER_REMOVAL_IN_PROGRESS_MESSAGE
} from '../../shared/worktree-removal-fence-error'

type WatcherRemovalGateState = {
  connectionId: string | null
  rootPath: string
  installCount: number
  removalCount: number
  installDrainWaiters: Set<() => void>
}

export type WatcherRemovalGate = {
  ready: Promise<void>
  release(): void
}

export class WatcherRemovalInProgressError extends Error {
  readonly code = 'watcher_removal_in_progress'

  constructor() {
    super(WATCHER_REMOVAL_IN_PROGRESS_MESSAGE)
    this.name = 'WatcherRemovalInProgressError'
  }
}

export class TerminalRemovalInProgressError extends Error {
  readonly code = 'terminal_removal_in_progress'

  constructor() {
    super(TERMINAL_REMOVAL_IN_PROGRESS_MESSAGE)
    this.name = 'TerminalRemovalInProgressError'
  }
}

const states = new Map<string, WatcherRemovalGateState>()

export function beginWatcherInstall(rootPath: string, connectionId?: string): () => void {
  return beginRemovalSensitiveInstall(
    rootPath,
    connectionId,
    () => new WatcherRemovalInProgressError()
  )
}

export function beginTerminalInstall(rootPath: string, connectionId?: string): () => void {
  return beginRemovalSensitiveInstall(
    rootPath,
    connectionId,
    () => new TerminalRemovalInProgressError()
  )
}

function beginRemovalSensitiveInstall(
  rootPath: string,
  connectionId: string | undefined,
  createRemovalError: () => Error
): () => void {
  const normalizedRoot = normalizeRuntimePathForComparison(rootPath)
  // Why: PTY admission can fence both worktree identity and cwd, which may be
  // parent/child roots; neither side may overlap an active removal.
  if (
    matchingHostStates(connectionId).some(
      (state) =>
        state.removalCount > 0 &&
        (isPathInsideOrEqual(state.rootPath, normalizedRoot) ||
          isPathInsideOrEqual(normalizedRoot, state.rootPath))
    )
  ) {
    throw createRemovalError()
  }
  const key = watcherRemovalGateKey(normalizedRoot, connectionId)
  const state = states.get(key) ?? createState(key, normalizedRoot, connectionId)
  state.installCount++
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    state.installCount--
    if (state.installCount === 0) {
      for (const resolve of state.installDrainWaiters) {
        resolve()
      }
      state.installDrainWaiters.clear()
      deleteIdleState(key, state)
    }
  }
}

export function acquireWatcherRemovalGate(
  rootPath: string,
  connectionId?: string
): WatcherRemovalGate {
  const normalizedRoot = normalizeRuntimePathForComparison(rootPath)
  const hostStates = matchingHostStates(connectionId)
  if (
    hostStates.some(
      (state) =>
        state.removalCount > 0 &&
        (isPathInsideOrEqual(state.rootPath, normalizedRoot) ||
          isPathInsideOrEqual(normalizedRoot, state.rootPath))
    )
  ) {
    // Why: desktop and runtime removal entry points have separate request
    // dedupe; the shared root fence must still prevent two destructive runs.
    throw new Error('Worktree deletion already in progress')
  }
  const key = watcherRemovalGateKey(normalizedRoot, connectionId)
  const state = states.get(key) ?? createState(key, normalizedRoot, connectionId)
  state.removalCount++
  // Why: deleting a parent root must wait for native installs already admitted
  // under that root, not only installs keyed to the exact same spelling.
  const drains = matchingHostStates(connectionId)
    .filter(
      (candidate) =>
        candidate.installCount > 0 && isPathInsideOrEqual(normalizedRoot, candidate.rootPath)
    )
    .map((candidate) => new Promise<void>((resolve) => candidate.installDrainWaiters.add(resolve)))
  const ready = drains.length === 0 ? Promise.resolve() : Promise.all(drains).then(() => undefined)
  let released = false
  return {
    ready,
    release: () => {
      if (released) {
        return
      }
      released = true
      state.removalCount--
      deleteIdleState(key, state)
    }
  }
}

export function isWatcherRemovalInProgressError(
  error: unknown
): error is WatcherRemovalInProgressError {
  return error instanceof WatcherRemovalInProgressError
}

function watcherRemovalGateKey(normalizedRoot: string, connectionId?: string): string {
  // Why: the same path can exist on local and multiple SSH hosts, while
  // Windows-equivalent spellings must still share one physical-removal fence.
  return JSON.stringify([connectionId ?? null, normalizedRoot])
}

function matchingHostStates(connectionId?: string): WatcherRemovalGateState[] {
  const host = connectionId ?? null
  return [...states.values()].filter((state) => state.connectionId === host)
}

function createState(
  key: string,
  rootPath: string,
  connectionId?: string
): WatcherRemovalGateState {
  const state = {
    connectionId: connectionId ?? null,
    rootPath,
    installCount: 0,
    removalCount: 0,
    installDrainWaiters: new Set<() => void>()
  }
  states.set(key, state)
  return state
}

function deleteIdleState(key: string, state: WatcherRemovalGateState): void {
  if (state.installCount === 0 && state.removalCount === 0 && states.get(key) === state) {
    states.delete(key)
  }
}
