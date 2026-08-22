import { existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { listCodexSessionRolloutFilesIncrementally } from './codex-session-file-listing'
import type { CodexSessionBridgeIncrementalOptions } from './codex-session-file-listing'
import { linkCodexSessionFile, tryHardlinkCodexSessionFile } from './codex-session-link'

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
}

const backgroundBridgeTasksByTargetHome = new Map<string, Promise<void>>()

/**
 * Starts one background bridge per target home, sharing in-flight work.
 */
export function startCodexAccountSessionBridgeInBackground(args: {
  targetCodexHomePath: string
  sourceCodexHomePaths: readonly string[]
  options?: CodexSessionBridgeIncrementalOptions
}): Promise<void> {
  const key = normalizeRuntimePathForComparison(args.targetCodexHomePath)
  const inFlight = backgroundBridgeTasksByTargetHome.get(key)
  if (inFlight) {
    return inFlight
  }
  const task = bridgeCodexSessionsIntoAccountHome(args)
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

/**
 * Mirrors every source home's rollouts into the target home's sessions tree.
 */
export async function bridgeCodexSessionsIntoAccountHome(args: {
  targetCodexHomePath: string
  sourceCodexHomePaths: readonly string[]
  options?: CodexSessionBridgeIncrementalOptions
}): Promise<CodexAccountSessionBridgeSummary> {
  const summary: CodexAccountSessionBridgeSummary = { scannedFiles: 0, linkedFiles: 0 }
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
      if (bridgeRolloutIntoAccountHome(sourceSessionsRoot, targetSessionsRoot, sourceFilePath)) {
        summary.linkedFiles += 1
      }
    }
  }
  return summary
}

/**
 * Links one named rollout into the target home ahead of the whole-tree bridge.
 *
 * Why: the background bridge walks every source home and can take seconds on a
 * large history. An account-switch restart has to resume one specific
 * conversation immediately, so it links that rollout first and lets the sweep
 * catch up. Returns the linked path, or null when it could not be placed.
 */
export function linkCodexRolloutIntoAccountHome(args: {
  sourceCodexHomePath: string
  targetCodexHomePath: string
  rolloutFilePath: string
}): string | null {
  const sourceSessionsRoot = join(args.sourceCodexHomePath, 'sessions')
  const targetSessionsRoot = join(args.targetCodexHomePath, 'sessions')
  const relativePath = relative(sourceSessionsRoot, args.rolloutFilePath)
  // Why: a rollout outside the source home's sessions tree has no place in the
  // target tree either; refusing beats inventing a path from `..` segments.
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return null
  }
  const targetFilePath = join(targetSessionsRoot, relativePath)
  if (isCodexResumableRollout(targetFilePath)) {
    return targetFilePath
  }
  // Why hardlink-only, unlike the sweep: Codex's resume picker ignores a
  // symlinked JSONL session, so accepting the sweep's cross-volume fallback here
  // would report a move that leaves the relaunched pane on a blank session.
  try {
    mkdirSync(dirname(targetFilePath), { recursive: true })
    // Why unlink first: the sweep may already have left a symlink at this exact
    // path, and a hardlink onto an occupied path fails EEXIST — which would make
    // the conversation permanently unmovable rather than merely unlisted.
    removeSymlinkAt(targetFilePath)
  } catch (error) {
    console.warn('[codex-account-session-bridge] Failed to prepare session path:', error)
    return null
  }
  if (tryHardlinkCodexSessionFile(args.rolloutFilePath, targetFilePath)) {
    return targetFilePath
  }
  // Why re-check: the background sweep walks the same tree, so it can hardlink
  // this rollout in the gap between the unlink above and this attempt. That
  // loses the race with EEXIST while leaving the conversation correctly listed,
  // and answering "not moved" there would discard it for no reason.
  return isCodexResumableRollout(targetFilePath) ? targetFilePath : null
}

/** Clears a symlink standing where a hardlink has to go; leaves real files alone. */
function removeSymlinkAt(filePath: string): void {
  try {
    if (!lstatSync(filePath).isSymbolicLink()) {
      return
    }
  } catch {
    return
  }
  unlinkSync(filePath)
}

/** A path Codex will actually list: a real file, never a symlink to one. */
function isCodexResumableRollout(filePath: string): boolean {
  try {
    const stats = lstatSync(filePath)
    return stats.isFile() && !stats.isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Links one rollout into the target sessions tree at the same relative path.
 */
function bridgeRolloutIntoAccountHome(
  sourceSessionsRoot: string,
  targetSessionsRoot: string,
  sourceFilePath: string
): boolean {
  const targetFilePath = join(targetSessionsRoot, relative(sourceSessionsRoot, sourceFilePath))
  // Why: rollout names carry the session UUID, so an existing target path is the
  // same conversation already bridged (often the same inode) — never a conflict.
  if (existsSync(targetFilePath)) {
    return false
  }
  try {
    mkdirSync(dirname(targetFilePath), { recursive: true })
  } catch (error) {
    console.warn('[codex-account-session-bridge] Failed to create session directory:', error)
    return false
  }
  return linkCodexSessionFile(sourceFilePath, targetFilePath)
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
  }
}
