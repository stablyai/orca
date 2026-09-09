import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import type { SessionFileDiscovery } from '../ai-vault/session-scanner-types'
import { wslGatedReaddir } from '../native-chat/wsl-transcript-fs-access'

/** A scan root the index could not read, and what stopped it. */
export type SessionSearchDegradedRoot = { root: string; reason: string }

// Why the indexer probes at all: the walker swallows a readdir failure and
// returns, so an EACCES root and an agent that was never installed both arrive
// as "no files". Reporting the first as an empty index would be the
// loss-of-contact-as-absence mistake docs/reference/ssh-execution-boundary.md
// forbids, so an empty root is re-checked and only ENOENT counts as absent.
const ABSENT_ROOT = new Set(['ENOENT', 'ENOTDIR'])

export type SessionSearchRootHealthOptions = {
  signal?: AbortSignal
  /** What each root listed last time, so a tree that emptied out is visible. */
  previousFileCounts?: ReadonlyMap<string, number>
}

/** Transcripts each root listed, for comparison against the next sweep. */
export function rootFileCounts(discoveries: readonly SessionFileDiscovery[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const discovery of discoveries) {
    counts.set(discovery.rootDir, (counts.get(discovery.rootDir) ?? 0) + discovery.files.length)
  }
  return counts
}

/**
 * Carries a root's last healthy count forward across a sweep that listed it
 * empty. Without this the alarm is single-shot: the degraded sweep's zero
 * becomes the baseline, the next sweep compares zero against zero, and the
 * unmounted tree is retired on the second pass instead of the first.
 */
export function withLastHealthyRootCounts(
  previous: ReadonlyMap<string, number>,
  observed: ReadonlyMap<string, number>
): Map<string, number> {
  const merged = new Map(previous)
  for (const [root, count] of observed) {
    if (count > 0) {
      merged.set(root, count)
    }
  }
  return merged
}

/**
 * Classifies the roots a sweep just walked. Only roots that yielded nothing are
 * probed: a root that returned files is readable by construction, which keeps
 * the cost at one readdir per genuinely empty tree.
 *
 * A readable but suddenly empty root counts too. An unmounted SSH home or a
 * detached external drive often reads as a present, listable, empty directory,
 * and every transcript under it then answers ENOENT at once. Going from N to
 * zero is not something an agent's transcript store does on its own.
 */
export async function degradedSessionSearchRoots(
  discoveries: readonly SessionFileDiscovery[],
  issues: readonly AiVaultScanIssue[],
  options: SessionSearchRootHealthOptions = {}
): Promise<SessionSearchDegradedRoot[]> {
  const { signal } = options
  const degraded = new Map<string, string>()
  for (const issue of issues) {
    if (issue.kind !== 'notice' && discoveries.some((one) => one.rootDir === issue.path)) {
      degraded.set(issue.path, issue.message)
    }
  }
  const counts = rootFileCounts(discoveries)
  for (const [root, count] of counts) {
    if (count > 0 || degraded.has(root) || signal?.aborted) {
      continue
    }
    const previous = options.previousFileCounts?.get(root) ?? 0
    if (previous > 0) {
      degraded.set(root, `Listed no transcripts where it listed ${previous} before.`)
      continue
    }
    const reason = await unreadableRootReason(root, signal)
    if (reason) {
      degraded.set(root, reason)
    }
  }
  return [...degraded].map(([root, reason]) => ({ root, reason }))
}

/** True when a path lives under a root this sweep could not trust. */
export function underDegradedRoot(
  path: string,
  degradedRoots: readonly SessionSearchDegradedRoot[]
): boolean {
  // Both separators: discovery joins with the platform's, and a root can arrive
  // from a config value written with the other one.
  return degradedRoots.some(
    (degraded) =>
      path === degraded.root ||
      path.startsWith(`${degraded.root}/`) ||
      path.startsWith(`${degraded.root}\\`)
  )
}

async function unreadableRootReason(root: string, signal?: AbortSignal): Promise<string | null> {
  try {
    await wslGatedReaddir(root, 'scan', signal)
    return null
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : null
    if (code !== null && ABSENT_ROOT.has(code)) {
      return null
    }
    return error instanceof Error ? error.message : String(error)
  }
}
