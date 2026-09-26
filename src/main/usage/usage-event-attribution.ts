import { getLocalUsageDay } from './usage-calendar-range'
import { normalizeComparablePath } from './usage-path-comparison'
import type { UsageWorktreeResolver } from './usage-worktree-resolver'

export type UnattributedUsageEvent = {
  timestamp: string
  cwd: string | null
}

export type UsageEventAttribution = {
  day: string
  projectKey: string
  projectLabel: string
  repoId: string | null
  worktreeId: string | null
}

function defaultProjectLabel(cwd: string | null): string {
  if (!cwd) {
    return 'Unknown location'
  }
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length >= 2 ? parts.slice(-2).join('/') : (parts.at(-1) ?? cwd)
}

export function attributeUsageEvent<T extends UnattributedUsageEvent>(
  event: T,
  resolveWorktree: UsageWorktreeResolver
): (T & UsageEventAttribution) | null {
  const day = getLocalUsageDay(event.timestamp)
  if (!day) {
    return null
  }
  const worktree = event.cwd ? resolveWorktree(event.cwd) : null
  return {
    ...event,
    day,
    projectKey: worktree
      ? `worktree:${worktree.worktreeId}`
      : event.cwd
        ? `cwd:${normalizeComparablePath(event.cwd)}`
        : 'unscoped',
    projectLabel: worktree?.displayName ?? defaultProjectLabel(event.cwd),
    repoId: worktree?.repoId ?? null,
    worktreeId: worktree?.worktreeId ?? null
  }
}
