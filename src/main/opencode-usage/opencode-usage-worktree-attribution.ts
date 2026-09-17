import { realpath } from 'node:fs/promises'
import { canonicalizeUsageWorktreePaths } from '../usage-worktree-canonicalizer'
import { normalizeComparablePath, normalizeFsPath } from '../usage/usage-path-comparison'
import type { UsageScanWorktreeRef } from '../usage/usage-provider-contract'
import type { UsageWorktreeResolver } from '../usage/usage-worktree-resolver'
import type { OpenCodeUsageAttributedEvent, OpenCodeUsageParsedEvent } from './types'

export type OpenCodeUsageWorktreeRef = UsageScanWorktreeRef

function getDefaultProjectLabel(cwd: string | null): string {
  if (!cwd) {
    return 'Unknown location'
  }
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length >= 2) {
    return parts.slice(-2).join('/')
  }
  return parts.at(-1) ?? cwd
}

function localDayFromTimestamp(timestamp: string): string | null {
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  const year = parsed.getFullYear()
  const month = String(parsed.getMonth() + 1).padStart(2, '0')
  const day = String(parsed.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export async function buildWorktreesWithCanonicalPaths(
  worktrees: OpenCodeUsageWorktreeRef[]
): Promise<(OpenCodeUsageWorktreeRef & { canonicalPath: string })[]> {
  return canonicalizeUsageWorktreePaths(worktrees, canonicalizePath)
}

async function canonicalizePath(pathValue: string): Promise<string> {
  try {
    return normalizeFsPath(await realpath(pathValue))
  } catch {
    return normalizeFsPath(pathValue)
  }
}

export async function attributeOpenCodeUsageEvent(
  event: OpenCodeUsageParsedEvent,
  resolveWorktree: UsageWorktreeResolver
): Promise<OpenCodeUsageAttributedEvent | null> {
  const day = localDayFromTimestamp(event.timestamp)
  if (!day) {
    return null
  }

  let repoId: string | null = null
  let worktreeId: string | null = null
  let projectKey = 'unscoped'
  let projectLabel = getDefaultProjectLabel(event.cwd)

  if (event.cwd) {
    const worktree = resolveWorktree(event.cwd)
    if (worktree) {
      repoId = worktree.repoId
      worktreeId = worktree.worktreeId
      projectKey = `worktree:${worktree.worktreeId}`
      projectLabel = worktree.displayName
    } else {
      projectKey = `cwd:${normalizeComparablePath(event.cwd)}`
    }
  }

  return {
    ...event,
    day,
    projectKey,
    projectLabel,
    repoId,
    worktreeId
  }
}
