import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import {
  CODEX_SESSION_ROLLOUT_EXTENSIONS,
  isCodexSessionRolloutPath
} from './session-scanner-codex-paths'
import { discoverFiles } from './session-scanner-discovery'
import type { SessionFileDiscovery } from './session-scanner-types'

export function codexSessionDiscoveries(
  rootDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  return rootDirs.map((rootDir) =>
    discoverFiles({
      rootDir,
      limit,
      agent: 'codex',
      issues,
      extensions: [...CODEX_SESSION_ROLLOUT_EXTENSIONS],
      // Why: `.zst` alone is too broad; only Codex `.jsonl.zst` rollouts qualify.
      filePredicate: isCodexSessionRolloutPath,
      // Why: sibling duplicates must not consume the recency limit, and the
      // writable plain rollout remains authoritative even when zstd is newer.
      candidatePathSelector: preferPlainCodexRolloutSiblings
    })
  )
}

function preferPlainCodexRolloutSiblings(paths: readonly string[]): string[] {
  const byPlainPath = new Map<string, string>()
  for (const path of paths) {
    const plainPath = path.endsWith('.jsonl.zst') ? path.slice(0, -'.zst'.length) : path
    const existing = byPlainPath.get(plainPath)
    if (!existing || path.endsWith('.jsonl')) {
      byPlainPath.set(plainPath, path)
    }
  }
  return [...byPlainPath.values()]
}
