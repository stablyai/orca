import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { listCodexSessionRolloutFilesIncrementally } from './codex-session-file-listing'
import type { CodexSessionBridgeIncrementalOptions } from './codex-session-file-listing'
import {
  createCodexAccountStateDb,
  healCodexAccountSessionIndex
} from './codex-account-session-index-heal'
import { parseCodexRolloutThreadId } from './codex-session-index-heal-state'
import { linkCodexSessionFile } from './codex-session-link'
import {
  countCodexSessionFilesUpTo,
  findNewestCodexStateDbPath,
  readCodexStateDbBackfillStatus
} from './codex-state-db'

/**
 * Bridges Codex history between Orca-managed Codex homes.
 *
 * Why: a managed account launches Codex against its own self-contained
 * CODEX_HOME, and Codex's `/resume` picker only lists rollouts under that home.
 * Without this, switching accounts hides every conversation the user recorded
 * under a different account (or under their real ~/.codex). Rollouts are
 * hardlinked, so each conversation stays one physical log no matter how many
 * homes list it.
 */

export type CodexAccountSessionBridgeSummary = {
  scannedFiles: number
  linkedFiles: number
  /** Thread id -> rollout timestamp for every rollout present in the target home via this bridge. */
  bridgedThreads: Map<string, string>
}

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

/**
 * Why: Codex indexes every rollout present when it first creates a home's state
 * DB, and the TUI gives up waiting after 30s. Linking history into a fresh home
 * first turns its first launch into a minutes-long backfill (#20669), so an
 * empty home gets its state DB before any history; the heal indexes it afterwards.
 */
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
  // Why: no DB in a home that has history means Codex keeps it elsewhere
  // (`sqlite_home`) or keeps none, so linking cannot stall a launch here.
  // `not-tracked` is a pre-backfill schema that Codex migrates to `pending`.
  return status.kind === 'complete' || status.kind === 'missing'
}

function hasSessionRollouts(codexHomePath: string): boolean {
  return countCodexSessionFilesUpTo(join(codexHomePath, 'sessions'), 1) > 0
}

/**
 * Starts one background bridge per target home, sharing in-flight work.
 */
export function startCodexAccountSessionBridgeInBackground(
  args: {
    targetCodexHomePath: string
    sourceCodexHomePaths: readonly string[]
    options?: CodexSessionBridgeIncrementalOptions
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

/**
 * Mirrors every source home's rollouts into the target home's sessions tree.
 */
export async function bridgeCodexSessionsIntoAccountHome(args: {
  targetCodexHomePath: string
  sourceCodexHomePaths: readonly string[]
  options?: CodexSessionBridgeIncrementalOptions
}): Promise<CodexAccountSessionBridgeSummary> {
  const summary: CodexAccountSessionBridgeSummary = {
    scannedFiles: 0,
    linkedFiles: 0,
    bridgedThreads: new Map()
  }
  const targetSessionsRoot = join(args.targetCodexHomePath, 'sessions')
  for (const sourceHomePath of dedupeSourceHomes(
    args.sourceCodexHomePaths,
    args.targetCodexHomePath
  )) {
    const sourceSessionsRoot = join(sourceHomePath, 'sessions')
    if (!existsSync(sourceSessionsRoot)) {
      continue
    }
    for await (const sourceFilePath of listCodexSessionRolloutFilesIncrementally(
      sourceSessionsRoot,
      args.options ?? {}
    )) {
      summary.scannedFiles += 1
      const result = bridgeRolloutIntoAccountHome(
        sourceSessionsRoot,
        targetSessionsRoot,
        sourceFilePath
      )
      if (result === 'linked') {
        summary.linkedFiles += 1
      }
      const rollout = parseCodexRolloutThreadId(sourceFilePath)
      if (result !== 'failed' && rollout) {
        summary.bridgedThreads.set(rollout.threadId, rollout.rolloutStamp)
      }
    }
  }
  return summary
}

/**
 * Links one rollout into the target sessions tree at the same relative path.
 */
function bridgeRolloutIntoAccountHome(
  sourceSessionsRoot: string,
  targetSessionsRoot: string,
  sourceFilePath: string
): 'linked' | 'existing' | 'failed' {
  const targetFilePath = join(targetSessionsRoot, relative(sourceSessionsRoot, sourceFilePath))
  // Why: rollout names carry the session UUID, so an existing target path is the
  // same conversation already bridged (often the same inode) — never a conflict.
  if (existsSync(targetFilePath)) {
    return 'existing'
  }
  try {
    mkdirSync(dirname(targetFilePath), { recursive: true })
  } catch (error) {
    console.warn('[codex-account-session-bridge] Failed to create session directory:', error)
    return 'failed'
  }
  return linkCodexSessionFile(sourceFilePath, targetFilePath) ? 'linked' : 'failed'
}

/**
 * Drops duplicate and self-referential sources so one launch links each home once.
 */
function dedupeSourceHomes(
  sourceCodexHomePaths: readonly string[],
  targetCodexHomePath: string
): string[] {
  const seen = new Set([normalizeRuntimePathForComparison(targetCodexHomePath)])
  const sources: string[] = []
  for (const sourceHomePath of sourceCodexHomePaths) {
    const key = normalizeRuntimePathForComparison(sourceHomePath)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    sources.push(sourceHomePath)
  }
  return sources
}

export const _internals = {
  resetBackgroundBridgeTasks: (): void => {
    backgroundBridgeTasksByTargetHome.clear()
    stopping = false
  }
}
