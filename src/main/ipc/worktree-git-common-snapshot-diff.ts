import { join } from 'node:path'
import type { WorktreeBasePollEvent } from './worktree-base-directory-poller'
import type { GitCommonEntrySnapshot } from './worktree-git-common-entry-snapshot'

const LINKED_WORKTREE_INDEX_FILE = 'index'
const LINKED_WORKTREE_HEAD_LOG_FILE = join('logs', 'HEAD')

export type GitCommonSnapshot = {
  worktreesDirSignature: string
  worktreesDirIdentity: string | null
  entries: Map<string, GitCommonEntrySnapshot>
  primarySignatures: Map<string, string>
  statusRefPaths: Set<string>
  statusRefSignatures: Map<string, string>
  didFullScan: boolean
}

// Why: inode identity distinguishes "worktrees/ was replaced" (prune + re-add
// recreates the dir) from "its contents changed". The narrow watcher's stream is
// bound to the old inode and is deaf after a swap, so it must resubscribe.
export function gitCommonDirectoryIdentity(signature: string): string | null {
  if (signature === 'missing') {
    return null
  }
  const sizeSeparator = signature.lastIndexOf(':')
  const inodeSeparator = signature.lastIndexOf(':', sizeSeparator - 1)
  return inodeSeparator === -1 ? signature : signature.slice(inodeSeparator + 1, sizeSeparator)
}

function classifySignatureDiff(
  prevSignature: string | null | undefined,
  nextSignature: string | null | undefined
): 'create' | 'update' | 'delete' | null {
  if (prevSignature == null && nextSignature == null) {
    return null
  }
  if (prevSignature == null) {
    return 'create'
  }
  if (nextSignature == null) {
    return 'delete'
  }
  return prevSignature === nextSignature ? null : 'update'
}

function diffSignatureMaps(
  prev: Map<string, string>,
  next: Map<string, string>,
  resolvePath: (name: string) => string
): WorktreeBasePollEvent[] {
  const events: WorktreeBasePollEvent[] = []
  const names = new Set([...prev.keys(), ...next.keys()])
  for (const name of names) {
    const type = classifySignatureDiff(prev.get(name), next.get(name))
    if (type) {
      events.push({ type, path: resolvePath(name) })
    }
  }
  return events
}

export function diffGitCommon(
  commonDirPath: string,
  prev: GitCommonSnapshot,
  next: GitCommonSnapshot
): WorktreeBasePollEvent[] {
  const events: WorktreeBasePollEvent[] = []
  const worktreesDir = join(commonDirPath, 'worktrees')
  const rootWasReplaced =
    prev.worktreesDirIdentity !== null &&
    next.worktreesDirIdentity !== null &&
    prev.worktreesDirIdentity !== next.worktreesDirIdentity
  if (rootWasReplaced) {
    events.push({ type: 'delete', path: worktreesDir }, { type: 'create', path: worktreesDir })
  } else {
    const worktreesDirDiff = classifySignatureDiff(
      prev.worktreesDirSignature === 'missing' ? null : prev.worktreesDirSignature,
      next.worktreesDirSignature === 'missing' ? null : next.worktreesDirSignature
    )
    if (worktreesDirDiff) {
      events.push({ type: worktreesDirDiff, path: worktreesDir })
    }
  }
  for (const [entryPath, entry] of next.entries) {
    const prevEntry = prev.entries.get(entryPath)
    if (!prevEntry) {
      events.push({ type: 'create', path: entryPath })
      continue
    }
    events.push(
      ...diffSignatureMaps(prevEntry.structuralSignatures, entry.structuralSignatures, (name) =>
        join(entryPath, name)
      )
    )
    const indexDiff = classifySignatureDiff(prevEntry.indexSignature, entry.indexSignature)
    if (indexDiff) {
      events.push({ type: indexDiff, path: join(entryPath, LINKED_WORKTREE_INDEX_FILE) })
    }
    const headLogDiff = classifySignatureDiff(prevEntry.headLogSignature, entry.headLogSignature)
    if (headLogDiff) {
      events.push({ type: headLogDiff, path: join(entryPath, LINKED_WORKTREE_HEAD_LOG_FILE) })
    }
  }
  for (const entryPath of prev.entries.keys()) {
    if (!next.entries.has(entryPath)) {
      events.push({ type: 'delete', path: entryPath })
    }
  }
  events.push(
    ...diffSignatureMaps(prev.primarySignatures, next.primarySignatures, (name) =>
      join(commonDirPath, name)
    )
  )
  for (const path of next.statusRefPaths) {
    // A newly selected ref is a baseline change, not a filesystem event.
    if (!prev.statusRefPaths.has(path)) {
      continue
    }
    const type = classifySignatureDiff(
      prev.statusRefSignatures.get(path),
      next.statusRefSignatures.get(path)
    )
    if (type) {
      events.push({ type, path })
    }
  }
  return events
}
