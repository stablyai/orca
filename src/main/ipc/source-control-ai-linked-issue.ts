import { resolve } from 'node:path'
import type { Store } from '../persistence'
import { isLinkedIssueNumber } from '../../shared/source-control-ai-action-variables'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'

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
    // SSH paths remain remote POSIX strings; local Windows resolve/case-folding would corrupt them.
    return trimTrailingSeparators(idWorktreePath) === trimTrailingSeparators(args.worktreePath)
  }
  const candidates = new Set(
    [args.worktreePath, resolvedWorktreePath ?? args.worktreePath].map(comparableLocalPath)
  )
  return candidates.has(comparableLocalPath(idWorktreePath))
}

/** Validate independent ID/path/repo inputs; renderer-derived stale pairs still agree.
 * Folder workspace suffixes remain part of the raw metadata key while validation uses the stripped path. */
export function resolveSourceControlAiLinkedIssueMeta(
  store: Store,
  args: LinkedIssueLookupArgs,
  resolvedWorktreePath?: string
): WorktreeMeta | null {
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
  // Empty-string repoId must fail validation rather than disable the cross-check.
  if (typeof args.repoId === 'string' && parsed.repoId !== args.repoId) {
    return null
  }
  if (!matchesRequestPath(parsed.worktreePath, args, resolvedWorktreePath)) {
    return null
  }
  return store.getWorktreeMeta(args.worktreeId) ?? null
}

export function resolveSourceControlAiLinkedIssue(
  store: Store,
  args: LinkedIssueLookupArgs,
  resolvedWorktreePath?: string
): number | null {
  const linkedIssue = resolveSourceControlAiLinkedIssueMeta(
    store,
    args,
    resolvedWorktreePath
  )?.linkedIssue
  // This metadata source supports GitHub links only.
  return isLinkedIssueNumber(linkedIssue) ? linkedIssue : null
}
