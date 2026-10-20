import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { wslGatedReaddir } from '../native-chat/wsl-transcript-fs-access'
import type { WslTranscriptFsTaskPriority } from '../native-chat/wsl-transcript-fs-gate'
import { codexRolloutFileNameOf } from './codex-rollout-file-name'
import { readCodexRolloutSessionMeta } from './codex-rollout-session-meta'

// Codex refuses deeper lineage too; this only bounds a corrupt or cyclic chain.
const MAX_LINEAGE_DEPTH = 64

/** A prefix of another rollout this conversation inherits: bytes [0, endByteOffset). */
export type CodexRolloutSegment = { path: string; endByteOffset: number }

export type CodexRolloutLineage = {
  /** Oldest first; excludes the rollout itself. */
  ancestors: CodexRolloutSegment[]
  /** False when an ancestor named by `history_base` could not be found or read. */
  complete: boolean
}

/**
 * Follows `history_base` the way Codex rebuilds a reverted or forked thread:
 * each ancestor is located by rollout id in the same Codex home, and only its
 * prefix up to the recorded byte offset belongs to this conversation.
 */
export async function resolveCodexRolloutLineage(
  rolloutPath: string,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<CodexRolloutLineage> {
  const home = codexHomeOfRollout(rolloutPath)
  const ancestors: CodexRolloutSegment[] = []
  const seen = new Set<string>()
  let current = rolloutPath
  for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth += 1) {
    const meta = await readCodexRolloutSessionMeta(current, signal, priority)
    if (!meta) {
      // The rollout itself unreadable is not a broken lineage; an ancestor is.
      return { ancestors, complete: depth === 0 }
    }
    const base = meta.historyBase
    if (!base) {
      return { ancestors, complete: true }
    }
    if (!home || seen.has(base.rolloutId)) {
      return { ancestors, complete: false }
    }
    seen.add(base.rolloutId)
    const ancestorPath = await findCodexRolloutById(home, base.rolloutId, current, priority, signal)
    if (!ancestorPath) {
      return { ancestors, complete: false }
    }
    ancestors.unshift({ path: ancestorPath, endByteOffset: base.endByteOffset })
    current = ancestorPath
  }
  return { ancestors, complete: false }
}

// Why: cut the original string so a remote or WSL path keeps its own separators.
function codexHomeOfRollout(rolloutPath: string): string | null {
  const match = /^(.*)[\\/](?:archived_)?sessions[\\/]/.exec(rolloutPath)
  return match?.[1] ? match[1] : null
}

/**
 * Newest dated directories first, starting at the child's own day: an ancestor
 * is always older than the rollout that names it, so the walk ends early.
 */
async function findCodexRolloutById(
  home: string,
  rolloutId: string,
  childPath: string,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<string | null> {
  const childName = codexRolloutFileNameOf(childPath)
  const childDay = childName?.timestamp.slice(0, 10) ?? '9999-99-99'
  const sessionsRoot = join(home, 'sessions')
  for (const year of await childDirectoryNames(sessionsRoot, priority, signal)) {
    for (const month of await childDirectoryNames(join(sessionsRoot, year), priority, signal)) {
      for (const day of await childDirectoryNames(
        join(sessionsRoot, year, month),
        priority,
        signal
      )) {
        if (`${year}-${month}-${day}` > childDay) {
          continue
        }
        const found = await findInDirectory(
          join(sessionsRoot, year, month, day),
          rolloutId,
          priority,
          signal
        )
        if (found) {
          return found
        }
      }
    }
  }
  return findInDirectory(join(home, 'archived_sessions'), rolloutId, priority, signal)
}

async function findInDirectory(
  directory: string,
  rolloutId: string,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<string | null> {
  const entries = await readDirectory(directory, priority, signal)
  // Why: Orca reads plain JSONL only; a compressed ancestor leaves the lineage incomplete.
  const match = entries.find(
    (entry) =>
      entry.isFile() &&
      entry.name.endsWith('.jsonl') &&
      codexRolloutFileNameOf(entry.name)?.rolloutId === rolloutId
  )
  return match ? join(directory, match.name) : null
}

async function childDirectoryNames(
  directory: string,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<string[]> {
  return (await readDirectory(directory, priority, signal))
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left))
}

async function readDirectory(
  directory: string,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<Dirent[]> {
  try {
    return await wslGatedReaddir(directory, priority, signal)
  } catch (error) {
    if (signal?.aborted) {
      throw error
    }
    return []
  }
}
