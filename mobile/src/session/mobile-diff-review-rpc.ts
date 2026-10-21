import type {
  MobileGitFileStatus,
  MobileGitStagingArea,
  MobileGitStatusEntry,
  MobileGitStatusResult,
  MobileGitUpstreamStatus
} from '../source-control/mobile-git-status'

// The one projection left here after the review readers became schemas: the open-PR prefill still
// re-normalizes a fresh `git.status` payload it already holds, which is a value in hand rather
// than a reply at a reader boundary.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function readFileStatus(value: unknown): MobileGitFileStatus | null {
  return value === 'modified' ||
    value === 'added' ||
    value === 'deleted' ||
    value === 'renamed' ||
    value === 'untracked' ||
    value === 'copied'
    ? value
    : null
}

function readStagingArea(value: unknown): MobileGitStagingArea | null {
  return value === 'staged' || value === 'unstaged' || value === 'untracked' ? value : null
}

function readConflictOperation(value: unknown): MobileGitStatusResult['conflictOperation'] {
  return value === 'merge' || value === 'rebase' || value === 'cherry-pick' || value === 'unknown'
    ? value
    : 'unknown'
}

function readUpstreamStatus(value: unknown): MobileGitUpstreamStatus | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const hasUpstream = readBoolean(value.hasUpstream)
  const ahead = readNumber(value.ahead)
  const behind = readNumber(value.behind)
  if (hasUpstream === undefined || ahead === undefined || behind === undefined) {
    return undefined
  }
  return {
    hasUpstream,
    upstreamName: readString(value.upstreamName),
    ahead,
    behind,
    hasConfiguredPushTarget: readBoolean(value.hasConfiguredPushTarget),
    behindCommitsArePatchEquivalent: readBoolean(value.behindCommitsArePatchEquivalent)
  }
}

function readStatusEntry(value: unknown): MobileGitStatusEntry | null {
  if (!isRecord(value)) {
    return null
  }
  const path = readString(value.path)
  const status = readFileStatus(value.status)
  const area = readStagingArea(value.area)
  if (!path || !status || !area) {
    return null
  }
  return {
    path,
    status,
    area,
    oldPath: readString(value.oldPath),
    conflictKind: undefined,
    conflictStatus:
      value.conflictStatus === 'unresolved' || value.conflictStatus === 'resolved_locally'
        ? value.conflictStatus
        : undefined,
    conflictStatusSource:
      value.conflictStatusSource === 'git' || value.conflictStatusSource === 'session'
        ? value.conflictStatusSource
        : undefined,
    added: readNumber(value.added),
    removed: readNumber(value.removed)
  }
}

export function readMobileGitStatusResult(value: unknown): MobileGitStatusResult | null {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    return null
  }
  return {
    entries: value.entries.flatMap((entry): MobileGitStatusEntry[] => {
      const parsed = readStatusEntry(entry)
      return parsed ? [parsed] : []
    }),
    conflictOperation: readConflictOperation(value.conflictOperation),
    branch: readString(value.branch),
    head: readString(value.head),
    upstreamStatus: readUpstreamStatus(value.upstreamStatus)
  }
}
