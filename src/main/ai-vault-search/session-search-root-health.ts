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

/**
 * Classifies the roots a sweep just walked. Only roots that yielded nothing are
 * probed: a root that returned files is readable by construction, which keeps
 * the per-cycle cost at one readdir per genuinely empty tree.
 */
export async function degradedSessionSearchRoots(
  discoveries: readonly SessionFileDiscovery[],
  issues: readonly AiVaultScanIssue[],
  signal?: AbortSignal
): Promise<SessionSearchDegradedRoot[]> {
  const degraded = new Map<string, string>()
  for (const issue of issues) {
    if (issue.kind !== 'notice' && discoveries.some((one) => one.rootDir === issue.path)) {
      degraded.set(issue.path, issue.message)
    }
  }
  const empty = [
    ...new Set(
      discoveries.filter((one) => one.files.length === 0).map((discovery) => discovery.rootDir)
    )
  ]
  for (const root of empty) {
    if (degraded.has(root) || signal?.aborted) {
      continue
    }
    const reason = await unreadableRootReason(root, signal)
    if (reason) {
      degraded.set(root, reason)
    }
  }
  return [...degraded].map(([root, reason]) => ({ root, reason }))
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
