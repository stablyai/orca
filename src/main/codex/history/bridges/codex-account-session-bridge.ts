import { join } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import {
  createCodexAccountStateDb,
  healCodexAccountSessionIndex
} from '../index/codex-account-session-index-heal'
import {
  linkMissingCodexSessionRollouts,
  type CodexSessionLinkPass
} from '../rollouts/codex-session-link-pass'
import {
  countCodexSessionFilesUpTo,
  findNewestCodexStateDbPath,
  readCodexStateDbBackfillStatus
} from '../index/codex-state-db'

// Hardlink history across homes so account switching preserves /resume entries and one physical log.
export type CodexAccountSessionBridgeSummary = CodexSessionLinkPass

const backgroundBridgeTasksByTargetHome = new Map<string, Promise<void>>()
let stopping = false

type BackgroundBridgeDependencies = {
  createStateDb: typeof createCodexAccountStateDb
  healIndex: typeof healCodexAccountSessionIndex
}

const defaultBackgroundBridgeDependencies: BackgroundBridgeDependencies = {
  createStateDb: createCodexAccountStateDb,
  healIndex: healCodexAccountSessionIndex
}

// Create the DB before linking history to avoid first-launch backfill timeouts; heal indexes later.
async function isReadyForBridgedHistory(
  targetCodexHomePath: string,
  sourceCodexHomePaths: readonly string[],
  dependencies: BackgroundBridgeDependencies
): Promise<boolean> {
  if (
    !findNewestCodexStateDbPath(targetCodexHomePath) &&
    !hasSessionRollouts(targetCodexHomePath)
  ) {
    if (
      !sourceCodexHomePaths.some(hasSessionRollouts) ||
      !(await dependencies.createStateDb(targetCodexHomePath))
    ) {
      return false
    }
  }
  const status = readCodexStateDbBackfillStatus(targetCodexHomePath)
  if (status.kind === 'unreadable') {
    // Why: contention clears by the next launch; corruption would skip every launch, so surface it.
    console.warn(
      '[codex-account-session-bridge] Skipping history bridge; Codex state DB is unreadable:',
      status.error
    )
    return false
  }
  // Existing history without a local DB implies sqlite_home or an older CLI; linking is safe.
  // `not-tracked` is a pre-backfill schema that Codex migrates to `pending`.
  return status.kind === 'complete' || status.kind === 'missing'
}

function hasSessionRollouts(codexHomePath: string): boolean {
  return countCodexSessionFilesUpTo(join(codexHomePath, 'sessions'), 1) > 0
}

export function startCodexAccountSessionBridgeInBackground(
  args: {
    targetCodexHomePath: string
    sourceCodexHomePaths: readonly string[]
    /** Skip rather than symlink when a hardlink fails (cross-volume): for the user's own ~/.codex. */
    hardlinkOnly?: boolean
  },
  dependenciesOverride: Partial<BackgroundBridgeDependencies> = {}
): Promise<void> {
  if (stopping) {
    return Promise.resolve()
  }
  const key = normalizeRuntimePathForComparison(args.targetCodexHomePath)
  const inFlight = backgroundBridgeTasksByTargetHome.get(key)
  if (inFlight) {
    return inFlight
  }
  const dependencies = { ...defaultBackgroundBridgeDependencies, ...dependenciesOverride }
  const task = isReadyForBridgedHistory(
    args.targetCodexHomePath,
    args.sourceCodexHomePaths,
    dependencies
  )
    .then(async (ready) => {
      // Why: skip rather than feed a running backfill; the next launch retries.
      if (!ready || stopping) {
        return
      }
      const summary = await bridgeCodexSessionsIntoAccountHome(args)
      await dependencies.healIndex(args.targetCodexHomePath, summary.bridgedThreads, {
        shouldStop: () => stopping
      })
    })
    .catch((error: unknown) => {
      console.warn('[codex-account-session-bridge] Background session bridge failed:', error)
    })
    .then(() => undefined)
  backgroundBridgeTasksByTargetHome.set(key, task)
  void task.finally(() => {
    if (backgroundBridgeTasksByTargetHome.get(key) === task) {
      backgroundBridgeTasksByTargetHome.delete(key)
    }
  })
  return task
}

/** Stops background bridges at quit; links and index reads made so far are kept. */
export function stopCodexAccountSessionBridges(): void {
  stopping = true
}

export function isCodexAccountSessionBridgeStopping(): boolean {
  return stopping
}

export async function bridgeCodexSessionsIntoAccountHome(args: {
  targetCodexHomePath: string
  sourceCodexHomePaths: readonly string[]
  hardlinkOnly?: boolean
}): Promise<CodexAccountSessionBridgeSummary> {
  return linkMissingCodexSessionRollouts({
    sourceCodexHomePaths: args.sourceCodexHomePaths,
    targetCodexHomePath: args.targetCodexHomePath,
    hardlinkOnly: args.hardlinkOnly,
    shouldStop: () => stopping
  })
}

export const _internals = {
  resetBackgroundBridgeTasks: (): void => {
    backgroundBridgeTasksByTargetHome.clear()
    stopping = false
  }
}
