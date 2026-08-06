import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'
import {
  TERMINAL_REMOVAL_IN_PROGRESS_MESSAGE,
  WATCHER_REMOVAL_IN_PROGRESS_MESSAGE
} from '../../shared/worktree-removal-fence-error'

// Why: fence slots are identities, not a counter, so a removal that gives up waiting can drop exactly
// the installs it waited on without a late finishInstall corrupting the count for a newer install.
type WatcherInstallToken = symbol

type WatcherRemovalGateState = {
  key: string
  connectionId: string | null
  rootPath: string
  installs: Set<WatcherInstallToken>
  removalCount: number
  installDrainWaiters: Set<() => void>
}

export type WatcherRemovalGate = {
  ready: Promise<void>
  /** Drop the install fence slots this removal waited on. Call only after `ready` timed out: the
   *  installs are presumed wedged, and leaving them counted makes every later removal of this root
   *  wait out the full drain budget again. */
  abandonPendingInstalls(): void
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
  const token: WatcherInstallToken = Symbol(normalizedRoot)
  state.installs.add(token)
  return () => {
    if (state.installs.delete(token) && state.installs.size === 0) {
      resolveInstallDrain(state)
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
  const fenced = matchingHostStates(connectionId)
    .filter(
      (candidate) =>
        candidate.installs.size > 0 && isPathInsideOrEqual(normalizedRoot, candidate.rootPath)
    )
    .map((candidate) => ({ state: candidate, tokens: new Set(candidate.installs) }))
  const drains = fenced.map(
    ({ state: candidate }) =>
      new Promise<void>((resolve) => candidate.installDrainWaiters.add(resolve))
  )
  const ready = drains.length === 0 ? Promise.resolve() : Promise.all(drains).then(() => undefined)
  let released = false
  return {
    ready,
    abandonPendingInstalls: () => {
      for (const { state: candidate, tokens } of fenced) {
        for (const token of tokens) {
          candidate.installs.delete(token)
        }
        if (candidate.installs.size === 0) {
          resolveInstallDrain(candidate)
        }
      }
    },
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
    key,
    connectionId: connectionId ?? null,
    rootPath,
    installs: new Set<WatcherInstallToken>(),
    removalCount: 0,
    installDrainWaiters: new Set<() => void>()
  }
  states.set(key, state)
  return state
}

function resolveInstallDrain(state: WatcherRemovalGateState): void {
  for (const resolve of state.installDrainWaiters) {
    resolve()
  }
  state.installDrainWaiters.clear()
  deleteIdleState(state.key, state)
}

function deleteIdleState(key: string, state: WatcherRemovalGateState): void {
  if (state.installs.size === 0 && state.removalCount === 0 && states.get(key) === state) {
    states.delete(key)
  }
}
