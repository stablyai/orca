import { resolve } from 'node:path'
import type { Store } from '../persistence'
import { isLinkedIssueNumber } from '../../shared/source-control-ai-action-variables'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree-id'

export type LinkedIssueLookupArgs = {
  worktreeId?: string
  worktreePath: string
  repoId?: string
  connectionId?: string
}

function trimTrailingSeparators(value: string): string {
  return value.replace(/[\\/]+$/g, '')
}

function comparableLocalPath(value: string): string {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function matchesRequestPath(
  idWorktreePath: string,
  args: LinkedIssueLookupArgs,
  resolvedWorktreePath: string | undefined
): boolean {
  if (args.connectionId) {
    // Why: the SSH branch never resolves the path, so it is a remote POSIX string.
    // resolve()/case-folding it from a Windows host would rewrite it and never match.
    return trimTrailingSeparators(idWorktreePath) === trimTrailingSeparators(args.worktreePath)
  }
  const candidates = new Set(
    [args.worktreePath, resolvedWorktreePath ?? args.worktreePath].map(comparableLocalPath)
  )
  return candidates.has(comparableLocalPath(idWorktreePath))
}

/**
 * Resolve the workspace's linked GitHub issue for Source Control AI generation.
 *
 * The renderer-supplied `worktreeId` is advisory — the same trust model as
 * `getRepoForSourceControlAi` — so it is validated against the request's path
 * (and `repoId`) before the meta read.
 *
 * Scope of that guarantee: today's desktop renderer derives `worktreePath` from
 * `worktreeId` (`resolveLocalWorktreePath`), so its two operands always agree and
 * this check cannot reject a renderer call — including a stale id after a
 * workspace switch, which produces a matching stale *pair* (git then runs in that
 * same stale worktree, so the number still belongs to the tree being committed).
 * The validation exists for callers that supply id and path independently — a
 * relay, the CLI, or a future in-process caller — where a mismatched pair really
 * would read another workspace's meta. Keep it: it is cheap and fails closed.
 *
 * Meta is keyed by the raw id: the `::workspace:<uuid>` suffix of folder-repo
 * workspace instances is part of the key, while validation uses the stripped path.
 */
export function resolveSourceControlAiLinkedIssue(
  store: Store,
  args: LinkedIssueLookupArgs,
  resolvedWorktreePath?: string
): number | null {
  if (typeof args.worktreeId !== 'string' || !args.worktreeId) {
    return null
  }
  if (typeof store.getWorktreeMeta !== 'function') {
    return null
  }
  const parsed = splitWorktreeIdForFilesystem(args.worktreeId)
  if (!parsed) {
    return null
  }
  // Why: `typeof` rather than truthiness, so an empty-string repoId fails closed
  // instead of silently disabling the cross-check.
  if (typeof args.repoId === 'string' && parsed.repoId !== args.repoId) {
    return null
  }
  if (!matchesRequestPath(parsed.worktreePath, args, resolvedWorktreePath)) {
    return null
  }
  const linkedIssue = store.getWorktreeMeta(args.worktreeId)?.linkedIssue
  // Why: GitHub only in v1 — no `linkedGitLabIssue` dual-read.
  return isLinkedIssueNumber(linkedIssue) ? linkedIssue : null
}
