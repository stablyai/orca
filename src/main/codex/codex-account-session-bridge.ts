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

// Hardlink history across homes so account switching preserves /resume entries and one physical log.
export type CodexAccountSessionBridgeSummary = {
  scannedFiles: number
  linkedFiles: number
  /** Thread ID to rollout timestamp for history present in the target home. */
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

function bridgeRolloutIntoAccountHome(
  sourceSessionsRoot: string,
  targetSessionsRoot: string,
  sourceFilePath: string
): 'linked' | 'existing' | 'failed' {
  const targetFilePath = join(targetSessionsRoot, relative(sourceSessionsRoot, sourceFilePath))
  // Rollout filenames contain session UUIDs; an existing path already represents this conversation.
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
